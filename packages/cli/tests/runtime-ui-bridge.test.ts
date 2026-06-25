import { describe, expect, it } from "bun:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, createServer as createNetServer, type Server as NetServer } from "node:net";
import {
	DEFAULT_UI_BRIDGE_TARGETS,
	defaultRuntimeUiBridgeTargets,
	startRuntimeUiBridge,
	UI_ACCESS_COOKIE,
	UI_BRIDGE_LISTEN_HOST_ENV,
} from "../src/runtime/ui-bridge";

describe("runtime UI bridge defaults", () => {
	it("uses bridge listen ports that do not collide with runtime loopback ports", () => {
		withBridgeListenEnv({}, () => {
			expect(defaultRuntimeUiBridgeTargets()).toEqual([
				{
					name: "openclaw",
					listenHost: "0.0.0.0",
					listenPort: 28789,
					targetHost: "127.0.0.1",
					targetPort: 18789,
				},
				{
					name: "hermes",
					listenHost: "0.0.0.0",
					listenPort: 28793,
					targetHost: "127.0.0.1",
					targetPort: 9119,
				},
			]);
		});
	});

	it("honors the explicit bridge listen host", () => {
		withBridgeListenEnv({ [UI_BRIDGE_LISTEN_HOST_ENV]: "10.42.0.20" }, () => {
			expect(defaultRuntimeUiBridgeTargets().map((target) => target.listenHost)).toEqual([
				"10.42.0.20",
				"10.42.0.20",
			]);
		});
	});
});

describe("runtime UI bridge", () => {
	it("reports health only after the target runtime is reachable", async () => {
		const upstream = createServer((_req, res) => {
			res.writeHead(200);
			res.end("upstream");
		});
		await listen(upstream, "127.0.0.1", 0);
		const upstreamPort = serverPort(upstream);
		const bridge = await startRuntimeUiBridge({
			token: "secret-token",
			targets: [
				{
					...DEFAULT_UI_BRIDGE_TARGETS[0],
					listenHost: "127.0.0.1",
					listenPort: 0,
					targetPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.targets[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		let upstreamClosed = false;
		try {
			const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("OK");

			await close(upstream);
			upstreamClosed = true;
			const unavailable = await fetch(`http://127.0.0.1:${bridgePort}/health`);
			expect(unavailable.status).toBe(503);
			expect(await unavailable.text()).toBe("Service Unavailable");
		} finally {
			await bridge.close();
			if (!upstreamClosed) await close(upstream);
		}
	});

	it("authenticates with query token, sets a cookie, and proxies cookie-authorized HTTP", async () => {
		const seen: Array<{ url: string; host: string | undefined }> = [];
		const upstream = createServer((req, res) => {
			seen.push({ url: req.url ?? "", host: req.headers.host });
			res.writeHead(200, {
				"Content-Type": "text/plain; charset=utf-8",
				"X-Upstream": "openclaw",
			});
			res.end(`upstream:${req.url ?? ""}`);
		});
		await listen(upstream, "127.0.0.1", 0);
		const upstreamPort = serverPort(upstream);
		const bridge = await startRuntimeUiBridge({
			token: "secret-token",
			targets: [
				{
					...DEFAULT_UI_BRIDGE_TARGETS[0],
					listenHost: "127.0.0.1",
					listenPort: 0,
					targetPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.targets[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const unauthorized = await fetch(`http://127.0.0.1:${bridgePort}/`);
			expect(unauthorized.status).toBe(401);

			const redirect = await fetch(
				`http://127.0.0.1:${bridgePort}/control?x=1&t=secret-token&y=2`,
				{ redirect: "manual" },
			);
			expect(redirect.status).toBe(302);
			expect(redirect.headers.get("location")).toBe("/control?x=1&y=2");
			const setCookie = redirect.headers.get("set-cookie") ?? "";
			expect(setCookie).toContain(`${UI_ACCESS_COOKIE}=secret-token`);
			expect(setCookie).toContain("Secure");
			expect(setCookie).toContain("HttpOnly");
			expect(setCookie).toContain("SameSite=Strict");
			expect(setCookie).toContain("Path=/");
			expect(seen).toEqual([]);

			const proxied = await fetch(`http://127.0.0.1:${bridgePort}/control?x=1&t=ignored`, {
				headers: { Cookie: `${UI_ACCESS_COOKIE}=secret-token` },
			});
			expect(proxied.status).toBe(200);
			expect(proxied.headers.get("x-upstream")).toBe("openclaw");
			expect(await proxied.text()).toBe("upstream:/control?x=1");
			expect(seen).toEqual([{ url: "/control?x=1", host: `127.0.0.1:${upstreamPort}` }]);
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("passes through server-sent event responses after cookie auth", async () => {
		const upstream = createServer((req, res) => {
			expect(req.url).toBe("/events");
			res.writeHead(200, {
				"Cache-Control": "no-cache",
				"Content-Type": "text/event-stream",
			});
			res.write("data: one\n\n");
			setTimeout(() => {
				res.end("data: two\n\n");
			}, 5);
		});
		await listen(upstream, "127.0.0.1", 0);
		const upstreamPort = serverPort(upstream);
		const bridge = await startRuntimeUiBridge({
			token: "sse-token",
			targets: [
				{
					...DEFAULT_UI_BRIDGE_TARGETS[0],
					listenHost: "127.0.0.1",
					listenPort: 0,
					targetPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.targets[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const response = await fetch(`http://127.0.0.1:${bridgePort}/events`, {
				headers: { Cookie: `${UI_ACCESS_COOKIE}=sse-token` },
			});

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("text/event-stream");
			expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("strips frame-blocking headers and preserves unrelated CSP directives for OpenClaw and Hermes", async () => {
		const makeUpstream = (name: string) =>
			createServer((req, res) => {
				res.writeHead(200, {
					"Content-Security-Policy":
						"default-src 'self'; frame-ancestors 'none'; script-src 'self'",
					"Content-Type": "text/html; charset=utf-8",
					"X-Frame-Options": name === "openclaw" ? "DENY" : "SAMEORIGIN",
					"X-Upstream": name,
				});
				res.end(`<html><body>${req.url ?? ""}</body></html>`);
			});
		const openclawUpstream = makeUpstream("openclaw");
		const hermesUpstream = makeUpstream("hermes");
		await listen(openclawUpstream, "127.0.0.1", 0);
		await listen(hermesUpstream, "127.0.0.1", 0);
		const bridge = await startRuntimeUiBridge({
			token: "frame-token",
			targets: [
				{
					...DEFAULT_UI_BRIDGE_TARGETS[0],
					listenHost: "127.0.0.1",
					listenPort: 0,
					targetPort: serverPort(openclawUpstream),
				},
				{
					...DEFAULT_UI_BRIDGE_TARGETS[1],
					listenHost: "127.0.0.1",
					listenPort: 0,
					targetPort: serverPort(hermesUpstream),
				},
			],
		});
		try {
			for (const target of bridge.targets) {
				const response = await fetch(`http://127.0.0.1:${target.listenPort}/dashboard`, {
					headers: { Cookie: `${UI_ACCESS_COOKIE}=frame-token` },
				});
				const csp = response.headers.get("content-security-policy") ?? "";

				expect(response.status).toBe(200);
				expect(response.headers.get("x-upstream")).toBe(target.name);
				expect(response.headers.get("x-frame-options")).toBeNull();
				expect(csp).toContain("default-src 'self'");
				expect(csp).toContain("script-src 'self'");
				expect(csp).toContain("frame-ancestors 'self' https://*.clawdi.ai");
				expect(csp).not.toContain("frame-ancestors 'none'");
			}
		} finally {
			await bridge.close();
			await close(openclawUpstream);
			await close(hermesUpstream);
		}
	});

	it("uses CLAWDI_UI_FRAME_ANCESTORS to configure allowed iframe ancestors", async () => {
		const previousFrameAncestors = process.env.CLAWDI_UI_FRAME_ANCESTORS;
		process.env.CLAWDI_UI_FRAME_ANCESTORS = "'self' https://console.clawdi.ai";
		const upstream = createServer((req, res) => {
			res.writeHead(200, {
				"Content-Security-Policy": "connect-src 'self'",
				"Content-Type": "text/html; charset=utf-8",
				"X-Frame-Options": "DENY",
			});
			res.end(`<html><body>${req.url ?? ""}</body></html>`);
		});
		await listen(upstream, "127.0.0.1", 0);
		const bridge = await startRuntimeUiBridge({
			token: "custom-frame-token",
			targets: [
				{
					...DEFAULT_UI_BRIDGE_TARGETS[0],
					listenHost: "127.0.0.1",
					listenPort: 0,
					targetPort: serverPort(upstream),
				},
			],
		});
		const bridgePort = bridge.targets[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const response = await fetch(`http://127.0.0.1:${bridgePort}/`, {
				headers: { Cookie: `${UI_ACCESS_COOKIE}=custom-frame-token` },
			});
			const csp = response.headers.get("content-security-policy") ?? "";

			expect(response.status).toBe(200);
			expect(response.headers.get("x-frame-options")).toBeNull();
			expect(csp).toContain("connect-src 'self'");
			expect(csp).toContain("frame-ancestors 'self' https://console.clawdi.ai");
			expect(csp).not.toContain("https://*.clawdi.ai");
		} finally {
			await bridge.close();
			await close(upstream);
			if (previousFrameAncestors === undefined) {
				delete process.env.CLAWDI_UI_FRAME_ANCESTORS;
			} else {
				process.env.CLAWDI_UI_FRAME_ANCESTORS = previousFrameAncestors;
			}
		}
	});

	it("strips proxy and Cloudflare forwarding headers from proxied HTTP", async () => {
		let seenHeaders: IncomingHttpHeaders | null = null;
		const upstream = createServer((req, res) => {
			seenHeaders = req.headers;
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("ok");
		});
		await listen(upstream, "127.0.0.1", 0);
		const upstreamPort = serverPort(upstream);
		const bridge = await startRuntimeUiBridge({
			token: "http-strip-token",
			targets: [
				{
					...DEFAULT_UI_BRIDGE_TARGETS[0],
					listenHost: "127.0.0.1",
					listenPort: 0,
					targetPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.targets[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const response = await fetch(`http://127.0.0.1:${bridgePort}/control`, {
				headers: {
					Cookie: `${UI_ACCESS_COOKIE}=http-strip-token`,
					"X-App-Header": "keep-me",
					"X-Forwarded": "legacy",
					"X-Forwarded-For": "10.42.0.1",
					"X-Forwarded-Host": "agent-18789.gateway.example.test",
					"X-Forwarded-Port": "443",
					"X-Forwarded-Prefix": "/control",
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Server": "ingress",
					"X-Real-IP": "198.51.100.8",
					Forwarded: "for=10.42.0.1;proto=https;host=agent-18789.gateway.example.test",
					"CF-Connecting-IP": "198.51.100.9",
					"CF-IPCountry": "US",
					"CF-Ray": "ray-id",
					"CF-Visitor": '{"scheme":"https"}',
					"CF-Worker": "worker-name",
				},
			});

			expect(response.status).toBe(200);
			expect(seenHeaders?.host).toBe(`127.0.0.1:${upstreamPort}`);
			expect(seenHeaders?.["x-app-header"]).toBe("keep-me");
			expect(seenHeaders?.["x-forwarded"]).toBeUndefined();
			expect(seenHeaders?.["x-forwarded-for"]).toBeUndefined();
			expect(seenHeaders?.["x-forwarded-host"]).toBeUndefined();
			expect(seenHeaders?.["x-forwarded-port"]).toBeUndefined();
			expect(seenHeaders?.["x-forwarded-prefix"]).toBeUndefined();
			expect(seenHeaders?.["x-forwarded-proto"]).toBeUndefined();
			expect(seenHeaders?.["x-forwarded-server"]).toBeUndefined();
			expect(seenHeaders?.["x-real-ip"]).toBeUndefined();
			expect(seenHeaders?.forwarded).toBeUndefined();
			expect(seenHeaders?.["cf-connecting-ip"]).toBeUndefined();
			expect(seenHeaders?.["cf-ipcountry"]).toBeUndefined();
			expect(seenHeaders?.["cf-ray"]).toBeUndefined();
			expect(seenHeaders?.["cf-visitor"]).toBeUndefined();
			expect(seenHeaders?.["cf-worker"]).toBeUndefined();
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("passes through websocket upgrades after auth", async () => {
		let upstreamRequest = "";
		const upstream = createNetServer((socket) => {
			socket.once("data", (chunk) => {
				upstreamRequest += chunk.toString("latin1");
				socket.write(
					[
						"HTTP/1.1 101 Switching Protocols",
						"Upgrade: websocket",
						"Connection: Upgrade",
						"",
						"",
					].join("\r\n"),
				);
			});
		});
		await listen(upstream, "127.0.0.1", 0);
		const upstreamPort = serverPort(upstream);
		const bridge = await startRuntimeUiBridge({
			token: "ws-token",
			targets: [
				{
					...DEFAULT_UI_BRIDGE_TARGETS[0],
					listenHost: "127.0.0.1",
					listenPort: 0,
					targetPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.targets[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const unauthorized = await websocketRequest({
				port: bridgePort,
				path: "/socket",
			});
			expect(unauthorized.statusCode).toBe(401);

			const redirect = await websocketRequest({
				port: bridgePort,
				path: "/socket?t=ws-token&x=1",
			});
			expect(redirect.statusCode).toBe(302);
			expect(redirect.location).toBe("/socket?x=1");
			expect(redirect.setCookie).toContain(`${UI_ACCESS_COOKIE}=ws-token`);

			const authorized = await websocketRequest({
				port: bridgePort,
				path: "/socket?x=1",
				cookie: `${UI_ACCESS_COOKIE}=ws-token`,
			});
			expect(authorized.statusCode).toBe(101);
			expect(authorized.setCookie).toBe("");
			expect(upstreamRequest).toContain("GET /socket?x=1 HTTP/1.1");
			expect(upstreamRequest).toContain(`Host: 127.0.0.1:${upstreamPort}`);
			expect(upstreamRequest).toContain("Connection: Upgrade");
			expect(upstreamRequest).toContain("Upgrade: websocket");
			expect(upstreamRequest).not.toContain("ws-token");
			expect(upstreamRequest).not.toContain(UI_ACCESS_COOKIE);
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("rewrites websocket browser authority headers to the OpenClaw loopback target", async () => {
		let upstreamRequest = "";
		const upstream = createNetServer((socket) => {
			socket.once("data", (chunk) => {
				upstreamRequest += chunk.toString("latin1");
				socket.write(
					[
						"HTTP/1.1 101 Switching Protocols",
						"Upgrade: websocket",
						"Connection: Upgrade",
						"",
						"",
					].join("\r\n"),
				);
			});
		});
		await listen(upstream, "127.0.0.1", 0);
		const upstreamPort = serverPort(upstream);
		const bridge = await startRuntimeUiBridge({
			token: "openclaw-token",
			targets: [
				{
					...DEFAULT_UI_BRIDGE_TARGETS[0],
					listenHost: "127.0.0.1",
					listenPort: 0,
					targetPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.targets[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const authorized = await websocketRequest({
				port: bridgePort,
				path: "/control/?session=abc",
				cookie: `${UI_ACCESS_COOKIE}=openclaw-token; app_cookie=keep`,
				host: "agent-18789.gateway.example.test",
				origin: "https://agent-18789.gateway.example.test",
				referer: "https://agent-18789.gateway.example.test/control/?session=abc",
				headers: forwardingHeaderLines(),
			});

			expect(authorized.statusCode).toBe(101);
			expect(upstreamRequest).toContain("GET /control/?session=abc HTTP/1.1");
			expect(upstreamRequest).toContain(`Host: 127.0.0.1:${upstreamPort}`);
			expect(upstreamRequest).toContain(`Origin: http://127.0.0.1:${upstreamPort}`);
			expect(upstreamRequest).toContain(
				`Referer: http://127.0.0.1:${upstreamPort}/control/?session=abc`,
			);
			expect(upstreamRequest).toContain("Cookie: app_cookie=keep");
			expect(upstreamRequest).toContain("X-App-Header: keep-me");
			expectForwardingHeadersStripped(upstreamRequest);
			expect(upstreamRequest).not.toContain("agent-18789.gateway.example.test");
			expect(upstreamRequest).not.toContain(UI_ACCESS_COOKIE);
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("proxies Hermes dashboard websocket paths with loopback origin and app query intact", async () => {
		let upstreamRequest = "";
		const upstream = createNetServer((socket) => {
			socket.once("data", (chunk) => {
				upstreamRequest += chunk.toString("latin1");
				const accepted =
					upstreamRequest.includes("GET /api/ws?token=hermes-session&channel=chat-1 HTTP/1.1") &&
					upstreamRequest.includes(`Host: 127.0.0.1:${serverPort(upstream)}`) &&
					upstreamRequest.includes(`Origin: http://127.0.0.1:${serverPort(upstream)}`) &&
					!hasForwardingHeader(upstreamRequest);
				socket.write(
					accepted
						? [
								"HTTP/1.1 101 Switching Protocols",
								"Upgrade: websocket",
								"Connection: Upgrade",
								"",
								"",
							].join("\r\n")
						: ["HTTP/1.1 403 Forbidden", "Connection: close", "Content-Length: 0", "", ""].join(
								"\r\n",
							),
				);
			});
		});
		await listen(upstream, "127.0.0.1", 0);
		const upstreamPort = serverPort(upstream);
		const bridge = await startRuntimeUiBridge({
			token: "hermes-bridge-token",
			targets: [
				{
					...DEFAULT_UI_BRIDGE_TARGETS[1],
					listenHost: "127.0.0.1",
					listenPort: 0,
					targetPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.targets[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const authorized = await websocketRequest({
				port: bridgePort,
				path: "/api/ws?token=hermes-session&channel=chat-1",
				cookie: `${UI_ACCESS_COOKIE}=hermes-bridge-token`,
				host: "agent-9119.gateway.example.test",
				origin: "https://agent-9119.gateway.example.test",
				referer: "https://agent-9119.gateway.example.test/chat",
				headers: forwardingHeaderLines(),
			});

			expect(authorized.statusCode).toBe(101);
			expect(upstreamRequest).toContain("GET /api/ws?token=hermes-session&channel=chat-1 HTTP/1.1");
			expect(upstreamRequest).toContain(`Host: 127.0.0.1:${upstreamPort}`);
			expect(upstreamRequest).toContain(`Origin: http://127.0.0.1:${upstreamPort}`);
			expect(upstreamRequest).toContain(`Referer: http://127.0.0.1:${upstreamPort}/chat`);
			expect(upstreamRequest).toContain("X-App-Header: keep-me");
			expectForwardingHeadersStripped(upstreamRequest);
			expect(upstreamRequest).not.toContain("agent-9119.gateway.example.test");
			expect(upstreamRequest).not.toContain(UI_ACCESS_COOKIE);
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});
});

function websocketRequest(input: {
	port: number;
	path: string;
	cookie?: string;
	host?: string;
	origin?: string;
	referer?: string;
	headers?: string[];
}): Promise<{ statusCode: number; setCookie: string; location: string }> {
	return new Promise((resolve, reject) => {
		const socket = connect(input.port, "127.0.0.1");
		let buffer = "";
		socket.once("error", reject);
		socket.on("data", (chunk) => {
			buffer += chunk.toString("latin1");
			if (!buffer.includes("\r\n\r\n")) return;
			socket.destroy();
			const [head] = buffer.split("\r\n\r\n");
			const lines = (head ?? "").split("\r\n");
			const statusCode = Number.parseInt(lines[0]?.split(" ")[1] ?? "0", 10);
			const setCookie =
				lines
					.find((line) => line.toLowerCase().startsWith("set-cookie:"))
					?.slice("set-cookie:".length)
					.trim() ?? "";
			const location =
				lines
					.find((line) => line.toLowerCase().startsWith("location:"))
					?.slice("location:".length)
					.trim() ?? "";
			resolve({ statusCode, setCookie, location });
		});
		socket.once("connect", () => {
			socket.write(
				[
					`GET ${input.path} HTTP/1.1`,
					`Host: ${input.host ?? `127.0.0.1:${input.port}`}`,
					"Connection: Upgrade",
					"Upgrade: websocket",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					"Sec-WebSocket-Version: 13",
					...(input.origin ? [`Origin: ${input.origin}`] : []),
					...(input.referer ? [`Referer: ${input.referer}`] : []),
					...(input.cookie ? [`Cookie: ${input.cookie}`] : []),
					...(input.headers ?? []),
					"",
					"",
				].join("\r\n"),
			);
		});
	});
}

function forwardingHeaderLines(): string[] {
	return [
		"X-App-Header: keep-me",
		"X-Forwarded: legacy",
		"X-Forwarded-For: 10.42.0.1",
		"X-Forwarded-Host: agent-18789.gateway.example.test",
		"X-Forwarded-Port: 443",
		"X-Forwarded-Prefix: /control",
		"X-Forwarded-Proto: https",
		"X-Forwarded-Server: ingress",
		"X-Real-IP: 198.51.100.8",
		"Forwarded: for=10.42.0.1;proto=https;host=agent-18789.gateway.example.test",
		"CF-Connecting-IP: 198.51.100.9",
		"CF-IPCountry: US",
		"CF-Ray: ray-id",
		'CF-Visitor: {"scheme":"https"}',
		"CF-Worker: worker-name",
	];
}

function withBridgeListenEnv(values: Record<string, string>, fn: () => void): void {
	const keys = [UI_BRIDGE_LISTEN_HOST_ENV];
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	try {
		for (const key of keys) delete process.env[key];
		for (const [key, value] of Object.entries(values)) process.env[key] = value;
		fn();
	} finally {
		for (const key of keys) {
			const value = previous.get(key);
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function expectForwardingHeadersStripped(rawRequest: string): void {
	expect(hasForwardingHeader(rawRequest)).toBe(false);
}

function hasForwardingHeader(rawRequest: string): boolean {
	return rawRequest.split("\r\n").some((line) => {
		const separator = line.indexOf(":");
		if (separator <= 0) return false;
		const lowerName = line.slice(0, separator).toLowerCase();
		return (
			lowerName === "forwarded" ||
			lowerName === "x-forwarded" ||
			lowerName.startsWith("x-forwarded-") ||
			lowerName === "x-real-ip" ||
			lowerName.startsWith("cf-")
		);
	});
}

function listen(server: Server | NetServer, host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function close(server: Server | NetServer): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function serverPort(server: Server | NetServer): number {
	const address = server.address();
	if (!address || typeof address !== "object") throw new Error("server has no TCP address");
	return address.port;
}
