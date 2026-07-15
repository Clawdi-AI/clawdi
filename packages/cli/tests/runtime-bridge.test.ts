import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, createServer as createNetServer, type Server as NetServer } from "node:net";
import {
	RUNTIME_BRIDGE_COOKIE,
	RUNTIME_BRIDGE_FRAME_ANCESTORS_ENV,
	RUNTIME_BRIDGE_REDEMPTION_QUERY_PARAM,
	RUNTIME_BRIDGE_SURFACES_ENV,
	startRuntimeBridge,
} from "../src/runtime/bridge";

const OPENCLAW_SURFACE = {
	name: "openclaw",
	kind: "control-ui",
	listenPort: 28789,
	upstreamPort: 18789,
} as const;

const HERMES_SURFACE = {
	name: "hermes",
	kind: "control-ui",
	listenPort: 28793,
	upstreamPort: 9119,
} as const;

describe("runtime bridge configuration", () => {
	it("requires explicit bridge surfaces", async () => {
		await expect(startRuntimeBridge({ token: "env-token" })).rejects.toThrow(
			"no runtime bridge surfaces configured",
		);
	});

	it("uses bridge surfaces declared in the runtime environment", async () => {
		const upstream = createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("env-surface");
		});
		await listen(upstream, "127.0.0.1", 0);
		const listenPort = await unusedTcpPort();
		const previousSurfaces = process.env[RUNTIME_BRIDGE_SURFACES_ENV];
		process.env[RUNTIME_BRIDGE_SURFACES_ENV] = JSON.stringify([
			{
				name: "openclaw",
				kind: "control-ui",
				listenHost: "127.0.0.1",
				listenPort,
				upstreamPort: serverPort(upstream),
			},
		]);
		const bridge = await startRuntimeBridge({ token: "env-token" });
		try {
			expect(bridge.surfaces).toEqual([
				{
					name: "openclaw",
					kind: "control-ui",
					listenHost: "127.0.0.1",
					listenPort,
					upstreamHost: "127.0.0.1",
					upstreamPort: serverPort(upstream),
				},
			]);
			const response = await fetch(`http://127.0.0.1:${listenPort}/`, {
				headers: { Cookie: `${RUNTIME_BRIDGE_COOKIE}=env-token` },
			});

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("env-surface");
		} finally {
			await bridge.close();
			await close(upstream);
			if (previousSurfaces === undefined) {
				delete process.env[RUNTIME_BRIDGE_SURFACES_ENV];
			} else {
				process.env[RUNTIME_BRIDGE_SURFACES_ENV] = previousSurfaces;
			}
		}
	});
});

describe("runtime bridge", () => {
	it("reports health only after the surface runtime is reachable", async () => {
		const upstream = createServer((_req, res) => {
			res.writeHead(200);
			res.end("upstream");
		});
		await listen(upstream, "127.0.0.1", 0);
		const upstreamPort = serverPort(upstream);
		const bridge = await startRuntimeBridge({
			token: "secret-token",
			surfaces: [
				{
					...OPENCLAW_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
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

	it("rejects legacy token query params and proxies cookie-authorized HTTP", async () => {
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
		const bridge = await startRuntimeBridge({
			token: "secret-token",
			surfaces: [
				{
					...OPENCLAW_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const unauthorized = await fetch(`http://127.0.0.1:${bridgePort}/`);
			expect(unauthorized.status).toBe(401);

			const redirect = await fetch(
				`http://127.0.0.1:${bridgePort}/control?x=1&t=secret-token&y=2`,
				{ redirect: "manual" },
			);
			expect(redirect.status).toBe(401);
			expect(redirect.headers.get("location")).toBeNull();
			expect(redirect.headers.get("set-cookie")).toBeNull();
			expect(seen).toEqual([]);

			const proxied = await fetch(`http://127.0.0.1:${bridgePort}/control?x=1`, {
				headers: { Cookie: `${RUNTIME_BRIDGE_COOKIE}=secret-token` },
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

	it("rejects Hermes dashboard legacy token query-param logins", async () => {
		let seen = 0;
		const upstream = createServer((_req, res) => {
			seen += 1;
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("hermes-dashboard");
		});
		await listen(upstream, "127.0.0.1", 0);
		const upstreamPort = serverPort(upstream);
		const bridge = await startRuntimeBridge({
			token: "hermes-token",
			surfaces: [
				{
					...HERMES_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort,
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const redirect = await fetch(`http://127.0.0.1:${bridgePort}/dashboard?t=hermes-token`, {
				redirect: "manual",
			});
			expect(redirect.status).toBe(401);
			expect(redirect.headers.get("location")).toBeNull();
			expect(redirect.headers.get("set-cookie")).toBeNull();
			expect(seen).toBe(0);
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("redeems short-lived one-time browser auth codes before cookie-authorized HTTP", async () => {
		const seen: string[] = [];
		const upstream = createServer((req, res) => {
			seen.push(req.url ?? "");
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("openclaw-ui");
		});
		await listen(upstream, "127.0.0.1", 0);
		const bridge = await startRuntimeBridge({
			token: "redemption-secret",
			surfaces: [
				{
					...OPENCLAW_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: serverPort(upstream),
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const code = runtimeUiRedemptionCode("redemption-secret", {
				jti: "single-use-code",
				exp: Math.floor(Date.now() / 1000) + 60,
			});
			const redirect = await fetch(
				`http://127.0.0.1:${bridgePort}/control?x=1&${RUNTIME_BRIDGE_REDEMPTION_QUERY_PARAM}=${code}`,
				{ redirect: "manual" },
			);
			expect(redirect.status).toBe(302);
			expect(redirect.headers.get("location")).toBe("control?x=1");
			const setCookie = redirect.headers.get("set-cookie") ?? "";
			expect(setCookie).toContain(`${RUNTIME_BRIDGE_COOKIE}=redemption-secret`);
			expect(seen).toEqual([]);

			const replay = await fetch(
				`http://127.0.0.1:${bridgePort}/control?${RUNTIME_BRIDGE_REDEMPTION_QUERY_PARAM}=${code}`,
				{ redirect: "manual" },
			);
			expect(replay.status).toBe(401);

			const expiredCode = runtimeUiRedemptionCode("redemption-secret", {
				jti: "expired-code",
				exp: Math.floor(Date.now() / 1000) - 1,
			});
			const expired = await fetch(
				`http://127.0.0.1:${bridgePort}/control?${RUNTIME_BRIDGE_REDEMPTION_QUERY_PARAM}=${expiredCode}`,
				{ redirect: "manual" },
			);
			expect(expired.status).toBe(401);

			const wrongRuntimeCode = runtimeUiRedemptionCode("redemption-secret", {
				jti: "wrong-runtime",
				runtime: "hermes",
			});
			const wrongRuntime = await fetch(
				`http://127.0.0.1:${bridgePort}/control?${RUNTIME_BRIDGE_REDEMPTION_QUERY_PARAM}=${wrongRuntimeCode}`,
				{ redirect: "manual" },
			);
			expect(wrongRuntime.status).toBe(401);

			const proxied = await fetch(
				`http://127.0.0.1:${bridgePort}/control?x=1&${RUNTIME_BRIDGE_REDEMPTION_QUERY_PARAM}=ignored`,
				{ headers: { Cookie: `${RUNTIME_BRIDGE_COOKIE}=redemption-secret` } },
			);
			expect(proxied.status).toBe(200);
			expect(await proxied.text()).toBe("openclaw-ui");
			expect(seen).toEqual(["/control?x=1"]);
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("rewrites root-absolute dashboard asset URLs for path-prefixed public routes", async () => {
		const upstream = createServer((req, res) => {
			if (req.url === "/dashboard") {
				const body =
					'<html><head><link rel="stylesheet" href="/assets/app.css"></head><body><script src="/assets/app.js"></script></body></html>';
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Length": Buffer.byteLength(body),
				});
				res.end(body);
				return;
			}
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("asset");
		});
		await listen(upstream, "127.0.0.1", 0);
		const upstreamPort = serverPort(upstream);
		const bridge = await startRuntimeBridge({
			token: "hermes-token",
			surfaces: [
				{
					...HERMES_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort,
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const response = await fetch(`http://127.0.0.1:${bridgePort}/dashboard`, {
				headers: {
					Cookie: `${RUNTIME_BRIDGE_COOKIE}=hermes-token`,
					"X-Forwarded-Prefix": "/v2-hermes-9119",
				},
			});
			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body).toContain('<script src="./__clawdi_runtime_bridge_prefix.js"></script>');
			expect(body).toContain('href="./assets/app.css"');
			expect(body).toContain('src="./assets/app.js"');
			expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("adds immutable caching only to successful GETs for content-hashed assets", async () => {
		const upstream = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://runtime.local");
			const headers: Record<string, string> = {
				"Content-Type": url.pathname.endsWith(".html")
					? "text/html; charset=utf-8"
					: "application/octet-stream",
			};
			if (url.searchParams.has("upstream-cache")) {
				headers["Cache-Control"] = "private, max-age=60";
			}
			res.writeHead(url.searchParams.has("missing") ? 404 : 200, headers);
			res.end("asset");
		});
		await listen(upstream, "127.0.0.1", 0);
		const bridge = await startRuntimeBridge({
			token: "asset-token",
			surfaces: [
				{
					...HERMES_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: serverPort(upstream),
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		const immutable = "public, max-age=31536000, immutable";
		const cases = [
			{
				name: "hashed JavaScript",
				path: "/assets/index-AbCd1234.js",
				expected: immutable,
			},
			{
				name: "hashed CSS behind a public path prefix",
				path: "/assets/theme-A_b-1234.css?theme=dark",
				headers: { "X-Forwarded-Prefix": "/v2-hermes-9119" },
				expected: immutable,
			},
			{ name: "HTML", path: "/assets/index-AbCd1234.html", expected: null },
			{ name: "API path", path: "/api/assets/index-AbCd1234.js", expected: null },
			{
				name: "upstream cache policy",
				path: "/assets/index-AbCd1234.js?upstream-cache=1",
				expected: "private, max-age=60",
			},
			{
				name: "non-200 response",
				path: "/assets/missing-AbCd1234.js?missing=1",
				status: 404,
				expected: null,
			},
			{
				name: "non-GET request",
				path: "/assets/index-AbCd1234.js",
				method: "POST",
				expected: null,
			},
			{ name: "unhashed filename", path: "/assets/index.js", expected: null },
		] as const;

		try {
			for (const testCase of cases) {
				const response = await bridgeHttpRequest({
					port: bridgePort,
					path: testCase.path,
					method: "method" in testCase ? testCase.method : "GET",
					headers: {
						...("headers" in testCase ? testCase.headers : {}),
					},
					cookie: `${RUNTIME_BRIDGE_COOKIE}=asset-token`,
				});
				expect(response.statusCode, testCase.name).toBe(
					"status" in testCase ? testCase.status : 200,
				);
				expect(response.headers.get("cache-control") ?? null, testCase.name).toBe(
					testCase.expected,
				);
			}
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("leaves wildcard-subdomain HTML bodies unchanged when no public path prefix is present", async () => {
		const html =
			'<html><head><link rel="stylesheet" href="/style.css"></head><body><script src="/app.js"></script></body></html>';
		const upstream = createServer((req, res) => {
			expect(req.url).toBe("/sessions/foo/");
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Length": Buffer.byteLength(html),
			});
			res.end(html);
		});
		await listen(upstream, "127.0.0.1", 0);
		const bridge = await startRuntimeBridge({
			token: "wildcard-token",
			surfaces: [
				{
					...HERMES_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: serverPort(upstream),
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const response = await fetch(`http://127.0.0.1:${bridgePort}/sessions/foo/`, {
				headers: { Cookie: `${RUNTIME_BRIDGE_COOKIE}=wildcard-token` },
			});
			const body = await response.text();

			expect(response.status).toBe(200);
			expect(body).toBe(html);
			expect(body).not.toContain("__clawdi_runtime_bridge_prefix.js");
			expect(body).not.toContain('href="./style.css"');
			expect(body).not.toContain('src="./app.js"');
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("passes through chunked text/html responses without body rewriting", async () => {
		const chunks = [
			'<html><head><link rel="stylesheet" href="/chunked.css"></head>',
			'<body><script src="/chunked.js"></script></body></html>',
		];
		const upstream = createServer((req, res) => {
			expect(req.url).toBe("/dashboard");
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.write(chunks[0]);
			setTimeout(() => res.end(chunks[1]), 5);
		});
		await listen(upstream, "127.0.0.1", 0);
		const bridge = await startRuntimeBridge({
			token: "chunked-token",
			surfaces: [
				{
					...HERMES_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: serverPort(upstream),
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const response = await fetch(`http://127.0.0.1:${bridgePort}/dashboard`, {
				headers: {
					Cookie: `${RUNTIME_BRIDGE_COOKIE}=chunked-token`,
					"X-Forwarded-Prefix": "/v2-hermes-9119",
				},
			});
			const body = await response.text();

			expect(response.status).toBe(200);
			expect(response.headers.get("transfer-encoding")).toBe("chunked");
			expect(response.headers.get("content-length")).toBeNull();
			expect(body).toBe(chunks.join(""));
			expect(body).not.toContain("__clawdi_runtime_bridge_prefix.js");
			expect(body).not.toContain('href="./chunked.css"');
			expect(body).not.toContain('src="./chunked.js"');
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("serves the browser path-prefix helper after cookie auth", async () => {
		const upstream = createServer((_req, res) => {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("upstream-not-used");
		});
		await listen(upstream, "127.0.0.1", 0);
		const bridge = await startRuntimeBridge({
			token: "prefix-token",
			surfaces: [
				{
					...HERMES_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: serverPort(upstream),
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const unauthorized = await fetch(
				`http://127.0.0.1:${bridgePort}/__clawdi_runtime_bridge_prefix.js`,
			);
			expect(unauthorized.status).toBe(401);

			const response = await fetch(
				`http://127.0.0.1:${bridgePort}/__clawdi_runtime_bridge_prefix.js`,
				{ headers: { Cookie: `${RUNTIME_BRIDGE_COOKIE}=prefix-token` } },
			);
			const body = await response.text();

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
			expect(body).toContain("window.history.pushState");
			expect(body).toContain("window.fetch");
			expect(body).toContain("window.WebSocket");
			expect(body).toContain("window.XMLHttpRequest.prototype.open");
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
		const bridge = await startRuntimeBridge({
			token: "sse-token",
			surfaces: [
				{
					...OPENCLAW_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const response = await fetch(`http://127.0.0.1:${bridgePort}/events`, {
				headers: { Cookie: `${RUNTIME_BRIDGE_COOKIE}=sse-token` },
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
		const bridge = await startRuntimeBridge({
			token: "frame-token",
			surfaces: [
				{
					...OPENCLAW_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: serverPort(openclawUpstream),
				},
				{
					...HERMES_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: serverPort(hermesUpstream),
				},
			],
		});
		try {
			for (const surface of bridge.surfaces) {
				const response = await fetch(`http://127.0.0.1:${surface.listenPort}/dashboard`, {
					headers: { Cookie: `${RUNTIME_BRIDGE_COOKIE}=frame-token` },
				});
				const csp = response.headers.get("content-security-policy") ?? "";

				expect(response.status).toBe(200);
				expect(response.headers.get("x-upstream")).toBe(surface.name);
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

	it("uses CLAWDI_RUNTIME_BRIDGE_FRAME_ANCESTORS to configure allowed iframe ancestors", async () => {
		const previousFrameAncestors = process.env[RUNTIME_BRIDGE_FRAME_ANCESTORS_ENV];
		process.env[RUNTIME_BRIDGE_FRAME_ANCESTORS_ENV] = "'self' https://console.clawdi.ai";
		const upstream = createServer((req, res) => {
			res.writeHead(200, {
				"Content-Security-Policy": "connect-src 'self'",
				"Content-Type": "text/html; charset=utf-8",
				"X-Frame-Options": "DENY",
			});
			res.end(`<html><body>${req.url ?? ""}</body></html>`);
		});
		await listen(upstream, "127.0.0.1", 0);
		const bridge = await startRuntimeBridge({
			token: "custom-frame-token",
			surfaces: [
				{
					...OPENCLAW_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: serverPort(upstream),
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const response = await fetch(`http://127.0.0.1:${bridgePort}/`, {
				headers: { Cookie: `${RUNTIME_BRIDGE_COOKIE}=custom-frame-token` },
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
				delete process.env[RUNTIME_BRIDGE_FRAME_ANCESTORS_ENV];
			} else {
				process.env[RUNTIME_BRIDGE_FRAME_ANCESTORS_ENV] = previousFrameAncestors;
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
		const bridge = await startRuntimeBridge({
			token: "http-strip-token",
			surfaces: [
				{
					...OPENCLAW_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const response = await fetch(`http://127.0.0.1:${bridgePort}/control`, {
				headers: {
					Cookie: `${RUNTIME_BRIDGE_COOKIE}=http-strip-token`,
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
		const bridge = await startRuntimeBridge({
			token: "ws-token",
			surfaces: [
				{
					...OPENCLAW_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const unauthorized = await websocketRequest({
				port: bridgePort,
				path: "/socket",
			});
			expect(unauthorized.statusCode).toBe(401);

			const legacyTokenParam = await websocketRequest({
				port: bridgePort,
				path: "/socket?t=ws-token&x=1",
			});
			expect(legacyTokenParam.statusCode).toBe(401);
			expect(legacyTokenParam.location).toBe("");
			expect(legacyTokenParam.setCookie).toBe("");

			const authorized = await websocketRequest({
				port: bridgePort,
				path: "/socket?x=1",
				cookie: `${RUNTIME_BRIDGE_COOKIE}=ws-token`,
			});
			expect(authorized.statusCode).toBe(101);
			expect(authorized.setCookie).toBe("");
			expect(upstreamRequest).toContain("GET /socket?x=1 HTTP/1.1");
			expect(upstreamRequest).toContain(`Host: 127.0.0.1:${upstreamPort}`);
			expect(upstreamRequest).toContain("Connection: Upgrade");
			expect(upstreamRequest).toContain("Upgrade: websocket");
			expect(upstreamRequest).not.toContain("ws-token");
			expect(upstreamRequest).not.toContain(RUNTIME_BRIDGE_COOKIE);
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});

	it("rewrites websocket browser authority headers to the OpenClaw loopback surface", async () => {
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
		const bridge = await startRuntimeBridge({
			token: "openclaw-token",
			surfaces: [
				{
					...OPENCLAW_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const authorized = await websocketRequest({
				port: bridgePort,
				path: "/control/?session=abc",
				cookie: `${RUNTIME_BRIDGE_COOKIE}=openclaw-token; app_cookie=keep`,
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
			expect(upstreamRequest).not.toContain(RUNTIME_BRIDGE_COOKIE);
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
		const bridge = await startRuntimeBridge({
			token: "hermes-bridge-token",
			surfaces: [
				{
					...HERMES_SURFACE,
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamPort: upstreamPort,
				},
			],
		});
		const bridgePort = bridge.surfaces[0]?.listenPort;
		if (bridgePort === undefined) throw new Error("bridge did not expose a port");
		try {
			const authorized = await websocketRequest({
				port: bridgePort,
				path: "/api/ws?token=hermes-session&channel=chat-1",
				cookie: `${RUNTIME_BRIDGE_COOKIE}=hermes-bridge-token`,
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
			expect(upstreamRequest).not.toContain(RUNTIME_BRIDGE_COOKIE);
		} finally {
			await bridge.close();
			await close(upstream);
		}
	});
});

function bridgeHttpRequest(input: {
	port: number;
	path: string;
	method: string;
	cookie: string;
	headers?: Record<string, string>;
}): Promise<{ statusCode: number; headers: Map<string, string> }> {
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
			const statusCode = Number.parseInt(lines.shift()?.split(" ")[1] ?? "0", 10);
			const headers = new Map<string, string>();
			for (const line of lines) {
				const separator = line.indexOf(":");
				if (separator <= 0) continue;
				headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
			}
			resolve({ statusCode, headers });
		});
		socket.once("connect", () => {
			socket.write(
				[
					`${input.method} ${input.path} HTTP/1.1`,
					`Host: 127.0.0.1:${input.port}`,
					"Connection: close",
					`Cookie: ${input.cookie}`,
					...(input.method === "GET" ? [] : ["Content-Length: 0"]),
					...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
					"",
					"",
				].join("\r\n"),
			);
		});
	});
}

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

function runtimeUiRedemptionCode(
	token: string,
	overrides: Partial<{
		deployment_id: string;
		runtime: "openclaw" | "hermes";
		jti: string;
		iat: number;
		exp: number;
	}> = {},
): string {
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		deployment_id: "hdep_test",
		exp: now + 60,
		iat: now,
		jti: "test-redemption",
		runtime: "openclaw",
		sub: "v2_hosted_runtime_ui",
		v: 1,
		...overrides,
	};
	const payloadPart = base64UrlEncode(Buffer.from(JSON.stringify(sortObject(payload)), "utf8"));
	const signaturePart = base64UrlEncode(
		createHmac("sha256", Buffer.from(token, "utf8")).update(payloadPart, "ascii").digest(),
	);
	return `${payloadPart}.${signaturePart}`;
}

function sortObject(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
	);
}

function base64UrlEncode(raw: Buffer): string {
	return raw.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
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

async function unusedTcpPort(): Promise<number> {
	const server = createNetServer();
	await listen(server, "127.0.0.1", 0);
	const port = serverPort(server);
	await close(server);
	return port;
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
