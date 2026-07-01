import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startRuntimeMitmSidecar } from "../src/runtime/mitm-sidecar";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let tmpRoot = "";

afterEach(() => {
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
	tmpRoot = "";
});

describe("runtime MITM sidecar launcher", () => {
	it("starts a native sidecar executable and stops it", async () => {
		tmpRoot = mkdtempSync(join(tmpdir(), "clawdi-runtime-mitm-sidecar-launcher-"));
		const fakeSidecar = join(tmpRoot, "fake-sidecar");
		const stopped = join(tmpRoot, "stopped.txt");
		const sidecarEnvOut = join(tmpRoot, "sidecar-env.txt");
		writeFileSync(
			fakeSidecar,
			[
				"#!/usr/bin/env sh",
				"trap 'printf stopped > \"$STOPPED\"; exit 0' TERM INT",
				[
					'printf "auth=%s\\nprofile=%s\\nsecret=%s\\n"',
					'"$' + '{CLAWDI_AUTH_TOKEN-}"',
					'"$' + '{CLAWDI_MITM_PROFILE_BUNDLE-}"',
					'"$' + '{CLAWDI_MITM_SECRET_FILE-}"',
					'> "$ENV_OUT"',
				].join(" "),
				'printf \'{"ready":true,"proxyUrl":"http://127.0.0.1:19090","caFile":"/tmp/fake-ca.pem"}\\n\'',
				"while :; do sleep 1; done",
				"",
			].join("\n"),
		);
		chmodSync(fakeSidecar, 0o755);
		const profileBundlePath = join(tmpRoot, "profiles.json");
		writeFileSync(
			profileBundlePath,
			JSON.stringify({
				schemaVersion: "clawdi.mitmProfiles.v1",
				generatedAt: "2026-06-05T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				profiles: [{ id: "test", enabled: true }],
			}),
		);

		const sidecar = await startRuntimeMitmSidecar({
			runtime: "hermes",
			profileBundlePath,
			env: {
				CLAWDI_AUTH_TOKEN: "must-not-reach-sidecar-env",
				CLAWDI_MITM_SIDECAR_PATH: fakeSidecar,
				STOPPED: stopped,
				ENV_OUT: sidecarEnvOut,
				CLAWDI_MITM_PROXY_URL: "http://127.0.0.1:0",
				CLAWDI_MITM_CA_FILE: join(tmpRoot, "ca.pem"),
				CLAWDI_MITM_SECRET_FILE: join(tmpRoot, "secrets.json"),
			},
		});

		expect(sidecar.proxyUrl).toBe("http://127.0.0.1:19090");
		expect(sidecar.caFile).toBe("/tmp/fake-ca.pem");
		await sidecar.stop();
		if (!sidecar.closed) throw new Error("expected sidecar closed promise");
		await expect(sidecar.closed).resolves.toEqual({ code: 0, signal: null });
		expect(readFileSync(stopped, "utf8")).toBe("stopped");
		expect(readFileSync(sidecarEnvOut, "utf8")).toBe("auth=\nprofile=\nsecret=\n");
	});

	it("starts a bundled native sidecar launcher", async () => {
		tmpRoot = mkdtempSync(join(tmpdir(), "clawdi-runtime-mitm-sidecar-bundle-"));
		const bundle = join(tmpRoot, "bundle");
		const bin = join(bundle, "bin");
		mkdirSync(bin, { recursive: true });
		const launcher = join(bin, "clawdi-mitm-sidecar");
		const stopped = join(tmpRoot, "bundle-stopped.txt");
		writeFileSync(
			launcher,
			[
				"#!/usr/bin/env sh",
				"trap 'printf stopped > \"$STOPPED\"; exit 0' TERM INT",
				'printf \'{"ready":true,"proxyUrl":"http://127.0.0.1:19191","caFile":"/tmp/bundle-ca.pem"}\\n\'',
				"while :; do sleep 1; done",
				"",
			].join("\n"),
		);
		chmodSync(launcher, 0o755);
		const profileBundlePath = join(tmpRoot, "profiles.json");
		writeFileSync(
			profileBundlePath,
			JSON.stringify({
				schemaVersion: "clawdi.mitmProfiles.v1",
				generatedAt: "2026-06-05T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				profiles: [{ id: "test", enabled: true }],
			}),
		);

		const sidecar = await startRuntimeMitmSidecar({
			runtime: "hermes",
			profileBundlePath,
			env: {
				CLAWDI_MITM_SIDECAR_BUNDLE: bundle,
				STOPPED: stopped,
				CLAWDI_MITM_PROXY_URL: "http://127.0.0.1:0",
				CLAWDI_MITM_CA_FILE: join(tmpRoot, "ca.pem"),
			},
		});

		expect(sidecar.proxyUrl).toBe("http://127.0.0.1:19191");
		expect(sidecar.caFile).toBe("/tmp/bundle-ca.pem");
		await sidecar.stop();
		expect(readFileSync(stopped, "utf8")).toBe("stopped");
	});

	it("rejects sidecars that report not ready", async () => {
		tmpRoot = mkdtempSync(join(tmpdir(), "clawdi-runtime-mitm-sidecar-not-ready-"));
		const fakeSidecar = join(tmpRoot, "fake-sidecar");
		writeFileSync(
			fakeSidecar,
			[
				"#!/usr/bin/env sh",
				'printf \'{"ready":false,"reason":"no-enabled-profiles"}\\n\'',
				"",
			].join("\n"),
		);
		chmodSync(fakeSidecar, 0o755);
		const profileBundlePath = join(tmpRoot, "profiles.json");
		writeFileSync(profileBundlePath, "{}\n");

		await expect(
			startRuntimeMitmSidecar({
				runtime: "hermes",
				profileBundlePath,
				env: {
					CLAWDI_MITM_SIDECAR_PATH: fakeSidecar,
					CLAWDI_MITM_PROXY_URL: "http://127.0.0.1:0",
					CLAWDI_MITM_CA_FILE: join(tmpRoot, "ca.pem"),
				},
			}),
		).rejects.toThrow("MITM sidecar did not become ready: no-enabled-profiles");
	});

	it("rejects non-loopback proxy listeners by default", async () => {
		tmpRoot = mkdtempSync(join(tmpdir(), "clawdi-runtime-mitm-sidecar-loopback-"));
		const sidecarEnv = resolveNativeSidecarEnv();
		if (!sidecarEnv) {
			console.warn("Skipping native sidecar loopback test: Go is not available.");
			return;
		}
		const profileBundlePath = join(tmpRoot, "profiles.json");
		writeFileSync(
			profileBundlePath,
			JSON.stringify({
				schemaVersion: "clawdi.mitmProfiles.v1",
				generatedAt: "2026-06-05T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				profiles: [
					{
						id: "deny-metadata",
						enabled: true,
						kind: "deny",
						match: { scheme: "https", host: "169.254.169.254", pathPrefix: "/" },
						priority: 1,
					},
				],
			}),
		);

		await expect(
			startRuntimeMitmSidecar({
				runtime: "hermes",
				profileBundlePath,
				env: {
					...sidecarEnv,
					CLAWDI_MITM_PROXY_URL: "http://0.0.0.0:0",
					CLAWDI_MITM_CA_FILE: join(tmpRoot, "ca.pem"),
				},
			}),
		).rejects.toThrow("refusing to listen on non-loopback MITM proxy host 0.0.0.0");
	}, 20_000);

	it("rejects sidecar profiles with non-HTTP upstream URLs", async () => {
		tmpRoot = mkdtempSync(join(tmpdir(), "clawdi-runtime-mitm-sidecar-invalid-profile-"));
		const sidecarEnv = resolveNativeSidecarEnv();
		if (!sidecarEnv) {
			console.warn("Skipping native sidecar profile validation test: Go is not available.");
			return;
		}
		const profileBundlePath = join(tmpRoot, "profiles.json");
		writeFileSync(
			profileBundlePath,
			JSON.stringify({
				schemaVersion: "clawdi.mitmProfiles.v1",
				generatedAt: "2026-06-05T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				profiles: [
					{
						id: "bad-upstream",
						enabled: true,
						kind: "http",
						match: { scheme: "https", host: "discord.com", pathPrefix: "/api/" },
						rewrite: { upstreamBaseUrl: "secret://runtime/channels/url" },
					},
				],
			}),
		);

		await expect(
			startRuntimeMitmSidecar({
				runtime: "hermes",
				profileBundlePath,
				env: {
					...sidecarEnv,
					CLAWDI_MITM_PROXY_URL: "http://127.0.0.1:0",
					CLAWDI_MITM_CA_FILE: join(tmpRoot, "ca.pem"),
				},
			}),
		).rejects.toThrow("rewrite.upstreamBaseUrl must use http, https, ws, or wss");
	});

	it("routes HTTPS CONNECT requests through the native sidecar", async () => {
		if (!commandExists("curl")) {
			console.warn("Skipping native sidecar routing test: curl is not available.");
			return;
		}
		tmpRoot = mkdtempSync(join(tmpdir(), "clawdi-runtime-mitm-sidecar-"));
		const sidecarEnv = resolveNativeSidecarEnv();
		if (!sidecarEnv) {
			console.warn("Skipping native sidecar routing test: Go is not available.");
			return;
		}

		const upstreamHits: Array<{ path: string; originalHost: string | undefined }> = [];
		const providerHits: Array<{
			path: string;
			originalHost: string | undefined;
			authorization: string | undefined;
		}> = [];
		const websocketHits: Array<{ path: string; originalHost: string | undefined }> = [];
		const upstream = http.createServer((req, res) => {
			const hit = {
				path: req.url ?? "",
				originalHost: req.headers["x-clawdi-original-host"]?.toString(),
			};
			if (hit.originalHost === "chatgpt.com" || hit.originalHost === "api.openai.com") {
				providerHits.push({
					...hit,
					authorization: req.headers.authorization,
				});
			} else {
				upstreamHits.push(hit);
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, via: "test-upstream" }));
		});
		const websocketUpstream = net.createServer((socket) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				buffer += chunk;
				if (!buffer.includes("\r\n\r\n")) return;
				socket.removeAllListeners("data");
				const head = parseHttpHead(buffer);
				const key = head.headers["sec-websocket-key"] ?? "";
				const accept = createHash("sha1")
					.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
					.digest("base64");
				websocketHits.push({
					path: head.path,
					originalHost: head.headers["x-clawdi-original-host"],
				});
				socket.write(
					[
						"HTTP/1.1 101 Switching Protocols",
						"Upgrade: websocket",
						"Connection: Upgrade",
						`Sec-WebSocket-Accept: ${accept}`,
						"",
						"",
					].join("\r\n"),
					() => setTimeout(() => socket.end(), 500),
				);
			});
		});
		await listen(upstream, 0, "127.0.0.1");
		await listen(websocketUpstream, 0, "127.0.0.1");
		const upstreamAddress = upstream.address();
		const websocketAddress = websocketUpstream.address();
		if (
			typeof upstreamAddress !== "object" ||
			!upstreamAddress ||
			typeof websocketAddress !== "object" ||
			!websocketAddress
		) {
			throw new Error("expected upstream TCP address");
		}

		const profileBundlePath = join(tmpRoot, "profiles.json");
		const secretFile = join(tmpRoot, "secrets.json");
		const caFile = join(tmpRoot, "ca.pem");
		writeFileSync(
			profileBundlePath,
			JSON.stringify({
				schemaVersion: "clawdi.mitmProfiles.v1",
				generatedAt: "2026-06-05T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				profiles: [
					{
						id: "discord-rest-channel",
						enabled: true,
						kind: "http",
						match: {
							scheme: "https",
							host: "discord.com",
							pathPrefix: "/api/",
							headers: {},
						},
						rewrite: {
							upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/discord`,
							preservePath: true,
							setHeaders: {},
						},
						logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
						priority: 100,
					},
					{
						id: "discord-gateway-channel",
						enabled: true,
						kind: "websocket",
						match: {
							scheme: "wss",
							host: "gateway.discord.gg",
							pathPrefix: "/",
							headers: {},
						},
						rewrite: {
							upstreamBaseUrl: `http://127.0.0.1:${websocketAddress.port}/discord/gateway`,
							preservePath: true,
							setHeaders: {},
						},
						priority: 110,
					},
					{
						id: "telegram-bot-api-channel",
						enabled: true,
						kind: "http",
						match: {
							scheme: "https",
							host: "api.telegram.org",
							pathPrefix: "/bot",
							headers: {},
						},
						rewrite: {
							upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/telegram`,
							preservePath: true,
							setHeaders: {},
						},
						priority: 115,
					},
					{
						id: "bluebubbles-imessage-channel",
						enabled: true,
						kind: "http",
						match: {
							scheme: "https",
							host: "bluebubbles.invalid",
							pathPrefix: "/api/",
							query: {},
						},
						rewrite: {
							upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/bluebubbles`,
							preservePath: true,
							setHeaders: {},
						},
						logging: { redactHeaders: [], redactUrlPatterns: ["password=[^&]+"] },
						priority: 120,
					},
					{
						id: "codex-openai-responses",
						enabled: true,
						kind: "provider",
						match: {
							scheme: "https",
							host: "api.openai.com",
							pathPrefix: "/v1/",
							headers: {
								authorization: {
									type: "equals",
									value: "clawdi-mitm-placeholder",
									prefix: "Bearer ",
								},
							},
						},
						rewrite: {
							upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/sub2api/v1/responses`,
							preservePath: false,
							setHeaders: {
								authorization: {
									type: "secretRef",
									secretRef: "secret://providers/openai/api-key",
									prefix: "Bearer ",
								},
							},
						},
						logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
						priority: 124,
					},
					{
						id: "codex-chatgpt-backend-responses",
						enabled: true,
						kind: "provider",
						match: {
							scheme: "https",
							host: "chatgpt.com",
							path: { type: "equals", value: "/backend-api/codex/responses" },
							headers: {
								authorization: {
									type: "equals",
									value: "clawdi-mitm-placeholder",
									prefix: "Bearer ",
								},
							},
						},
						rewrite: {
							upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/sub2api/backend-api/codex/responses`,
							preservePath: false,
							setHeaders: {
								authorization: {
									type: "secretRef",
									secretRef: "secret://providers/openai/api-key",
									prefix: "Bearer ",
								},
							},
						},
						logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
						priority: 125,
					},
				],
			}),
		);
		writeFileSync(
			secretFile,
			JSON.stringify({
				secrets: {
					"secret://providers/openai/api-key": "sk-managed-provider",
				},
			}),
		);

		const sidecar = await startRuntimeMitmSidecar({
			runtime: "hermes",
			profileBundlePath,
			env: {
				...sidecarEnv,
				CLAWDI_MITM_PROXY_URL: "http://127.0.0.1:0",
				CLAWDI_MITM_CA_FILE: caFile,
				CLAWDI_MITM_SECRET_FILE: secretFile,
			},
		});
		try {
			const routed = await requestThroughProxy({
				proxyUrl: sidecar.proxyUrl,
				caFile: sidecar.caFile,
				host: "discord.com",
				path: "/api/v10/users/@me",
				headers: { authorization: "Bot scoped-agent-token" },
			});
			expect(routed.status).toBe(200);
			expect(routed.body).toContain("test-upstream");
			expect(upstreamHits).toEqual([
				{ path: "/discord/api/v10/users/@me", originalHost: "discord.com" },
			]);

			const telegram = await requestThroughProxy({
				proxyUrl: sidecar.proxyUrl,
				caFile: sidecar.caFile,
				host: "api.telegram.org",
				path: "/botscoped-agent-token/getMe",
				headers: {},
			});
			expect(telegram.status).toBe(200);
			expect(upstreamHits).toEqual([
				{ path: "/discord/api/v10/users/@me", originalHost: "discord.com" },
				{ path: "/telegram/botscoped-agent-token/getMe", originalHost: "api.telegram.org" },
			]);

			const bluebubbles = await requestThroughProxy({
				proxyUrl: sidecar.proxyUrl,
				caFile: sidecar.caFile,
				host: "bluebubbles.invalid",
				path: "/api/v1/ping?password=scoped-agent-token",
				headers: {},
			});
			expect(bluebubbles.status).toBe(200);
			expect(upstreamHits).toEqual([
				{ path: "/discord/api/v10/users/@me", originalHost: "discord.com" },
				{ path: "/telegram/botscoped-agent-token/getMe", originalHost: "api.telegram.org" },
				{
					path: "/bluebubbles/api/v1/ping?password=scoped-agent-token",
					originalHost: "bluebubbles.invalid",
				},
			]);

			const chatgptCodex = await requestThroughProxy({
				proxyUrl: sidecar.proxyUrl,
				caFile: sidecar.caFile,
				host: "chatgpt.com",
				path: "/backend-api/codex/responses",
				headers: { authorization: "Bearer clawdi-mitm-placeholder" },
			});
			expect(chatgptCodex.status).toBe(200);
			expect(providerHits).toEqual([
				{
					path: "/sub2api/backend-api/codex/responses",
					originalHost: "chatgpt.com",
					authorization: "Bearer sk-managed-provider",
				},
			]);
			expect(JSON.stringify(providerHits)).not.toContain("user-chatgpt-token");
			expect(upstreamHits).toHaveLength(3);

			const openaiCodex = await requestThroughProxy({
				proxyUrl: sidecar.proxyUrl,
				caFile: sidecar.caFile,
				host: "api.openai.com",
				path: "/v1/responses",
				headers: { authorization: "Bearer clawdi-mitm-placeholder" },
			});
			expect(openaiCodex.status).toBe(200);
			expect(providerHits).toEqual([
				{
					path: "/sub2api/backend-api/codex/responses",
					originalHost: "chatgpt.com",
					authorization: "Bearer sk-managed-provider",
				},
				{
					path: "/sub2api/v1/responses",
					originalHost: "api.openai.com",
					authorization: "Bearer sk-managed-provider",
				},
			]);
			expect(upstreamHits).toHaveLength(3);

			const denied = await requestThroughProxy({
				proxyUrl: sidecar.proxyUrl,
				caFile: sidecar.caFile,
				host: "unmatched.example.test",
				path: "/not-managed",
				headers: {},
			});
			expect(denied.status).toBe(403);
			expect(upstreamHits).toHaveLength(3);
			expect(providerHits).toHaveLength(2);

			const gateway = await requestWebSocketThroughNodeProxy({
				proxyUrl: sidecar.proxyUrl,
				caFile: sidecar.caFile,
				host: "gateway.discord.gg",
				path: "/?v=10&encoding=json",
			});
			if (gateway.status !== 101) {
				throw new Error(JSON.stringify({ gateway, upstreamHits, websocketHits }, null, 2));
			}
			expect(gateway.status).toBe(101);
			expect(websocketHits).toEqual([
				{ path: "/discord/gateway/?v=10&encoding=json", originalHost: "gateway.discord.gg" },
			]);
		} finally {
			await sidecar.stop();
			await close(upstream);
			await close(websocketUpstream);
		}
	}, 60_000);
});

function commandExists(command: string): boolean {
	return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function resolveNativeSidecarEnv(): Record<string, string> | null {
	const bundle = process.env.CLAWDI_MITM_SIDECAR_BUNDLE?.trim();
	if (bundle) return { CLAWDI_MITM_SIDECAR_BUNDLE: bundle };

	const explicit = process.env.CLAWDI_MITM_SIDECAR_PATH?.trim();
	if (explicit) return { CLAWDI_MITM_SIDECAR_PATH: explicit };

	if (!commandExists("go")) return null;
	const sidecarPath = join(tmpRoot, "clawdi-mitm-sidecar");
	const result = spawnSync("go", ["build", "-trimpath", "-o", sidecarPath, "."], {
		cwd: join(cliRoot, "native", "mitm-sidecar"),
		encoding: "utf8",
		stdio: "pipe",
	});
	if (result.status !== 0) {
		throw new Error(`native sidecar build failed\n${result.stdout}${result.stderr}`);
	}
	return { CLAWDI_MITM_SIDECAR_PATH: sidecarPath };
}

function listen(server: http.Server | net.Server, port: number, host: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function close(server: http.Server | net.Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}

function parseHttpHead(raw: string): { path: string; headers: Record<string, string> } {
	const [requestLine = "", ...lines] = raw.split("\r\n");
	const [, path = "/"] = requestLine.split(" ");
	const headers: Record<string, string> = {};
	for (const line of lines) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
	}
	return { path, headers };
}

async function requestThroughProxy(input: {
	proxyUrl: string;
	caFile: string;
	host: string;
	path: string;
	headers: Record<string, string>;
}): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"curl",
			[
				"--silent",
				"--show-error",
				"--max-time",
				"10",
				"--http1.1",
				"--proxy",
				input.proxyUrl,
				"--cacert",
				input.caFile,
				...Object.entries(input.headers).flatMap(([key, value]) => ["-H", `${key}: ${value}`]),
				"-w",
				"\n%{http_code}",
				`https://${input.host}${input.path}`,
			],
			{ stdio: "pipe" },
		);
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`curl timed out\nstdout=${stdout}\nstderr=${stderr}`));
		}, 8_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			const lines = stdout.split("\n");
			const statusText = lines.pop() ?? "0";
			const status = Number.parseInt(statusText, 10);
			const body = lines.join("\n");
			if (code !== 0) {
				reject(new Error(`curl failed code=${code}\nstdout=${stdout}\nstderr=${stderr}`));
				return;
			}
			resolve({ status, body });
		});
		child.stdin.end();
	});
}

async function requestWebSocketThroughNodeProxy(input: {
	proxyUrl: string;
	caFile: string;
	host: string;
	path: string;
}): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const script = `
import https from "node:https";
import { randomBytes } from "node:crypto";

const key = randomBytes(16).toString("base64");
const req = https.request("https://${input.host}${input.path}", {
  headers: {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": key,
    "sec-websocket-version": "13",
  },
});
req.on("upgrade", (res, socket) => {
  console.log(JSON.stringify({ status: res.statusCode }));
  socket.destroy();
});
req.on("response", (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => {
    body += chunk;
  });
  res.on("end", () => {
    console.log(JSON.stringify({ status: res.statusCode, unexpectedResponse: true, body }));
  });
});
req.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
req.end();
`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? tmpdir(),
				HTTPS_PROXY: input.proxyUrl,
				HTTP_PROXY: input.proxyUrl,
				NO_PROXY: "",
				NODE_OPTIONS: [process.env.NODE_OPTIONS, "--use-env-proxy"].filter(Boolean).join(" "),
				NODE_USE_ENV_PROXY: "1",
				NODE_EXTRA_CA_CERTS: input.caFile,
				SSL_CERT_FILE: input.caFile,
			},
			stdio: "pipe",
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`node websocket request timed out\nstdout=${stdout}\nstderr=${stderr}`));
		}, 8_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(
					new Error(
						`node websocket request failed code=${code}\nstdout=${stdout}\nstderr=${stderr}`,
					),
				);
				return;
			}
			const parsed = JSON.parse(stdout.trim()) as { status?: unknown; body?: unknown };
			resolve({
				status: typeof parsed.status === "number" ? parsed.status : 0,
				body: typeof parsed.body === "string" ? parsed.body : "",
			});
		});
	});
}
