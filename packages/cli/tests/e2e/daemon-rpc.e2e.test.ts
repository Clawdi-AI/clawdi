import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..", "..");
const srcEntry = join(cliRoot, "src", "index.ts");
const ENV_ID = "env-daemon-rpc-e2e";
const PROJECT_ID = "project-daemon-rpc-e2e";
const API_KEY = "daemon-rpc-e2e-key";

interface ApiCall {
	method: string;
	path: string;
	auth: string | null;
	body?: unknown;
}

interface Fixture {
	root: string;
	home: string;
	clawdiHome: string;
	stateDir: string;
	serviceStateDir: string;
	runDir: string;
	codexHome: string;
}

let server: ReturnType<typeof Bun.serve>;
let apiCalls: ApiCall[] = [];
let sseControllers: ReadableStreamDefaultController<Uint8Array>[] = [];

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "POST" ? await readJsonBody(req) : undefined;
			apiCalls.push({
				method: req.method,
				path: `${url.pathname}${url.search}`,
				auth: req.headers.get("authorization"),
				body,
			});

			if (req.method === "GET" && url.pathname === `/v1/agents/${ENV_ID}`) {
				return json({
					id: ENV_ID,
					default_project_id: PROJECT_ID,
				});
			}

			if (req.method === "GET" && url.pathname === "/v1/skills") {
				return json(
					{
						items: [],
						total: 0,
						page: 1,
						page_size: 200,
					},
					200,
					{ ETag: `"1:${PROJECT_ID}"` },
				);
			}

			if (req.method === "GET" && url.pathname === "/v1/sync/events") {
				return sse();
			}

			if (req.method === "POST" && url.pathname === `/v1/agents/${ENV_ID}/sync-heartbeat`) {
				return new Response(null, { status: 204 });
			}

			if (
				req.method === "POST" &&
				url.pathname === `/v2/runtime/environments/${ENV_ID}/observations`
			) {
				// A v2 transport failure must not poison the independent v1
				// liveness heartbeat or prevent its health-file update.
				return json({ detail: "temporary v2 failure" }, 503);
			}

			return json({ detail: "not found" }, 404);
		},
	});
});

afterAll(() => {
	for (const controller of sseControllers) {
		try {
			controller.close();
		} catch {
			/* already closed */
		}
	}
	server.stop(true);
});

beforeEach(() => {
	apiCalls = [];
	sseControllers = [];
});

if (process.platform !== "win32") {
	describe("daemon RPC process e2e", () => {
		it("serves daemon RPC over the configured HTTP port", async () => {
			const fixture = createFixture();
			const daemon = startDaemon(fixture);
			const daemonStdout = new Response(daemon.stdout).text();
			const [stderrReady, stderrText] = daemon.stderr.tee();
			const daemonStderr = new Response(stderrText).text();
			let failure: unknown;
			let daemonStdoutText = "";
			let daemonStderrText = "";

			try {
				const rpcPort = await waitForRpcListening(stderrReady);
				await waitFor(() => existsSync(join(fixture.stateDir, "control", "control-token")));
				await waitForHttpUnauthorized(rpcPort);

				const noToken = await postRpcWithoutToken(rpcPort);
				expect(noToken.status).toBe(401);

				const defaultPing = await runCli(fixture, ["daemon", "ping", "--port", String(rpcPort)]);
				expect(defaultPing.code).toBe(0);
				expect(defaultPing.stderr).toBe("");
				const defaultResult = JSON.parse(defaultPing.stdout) as { pid?: number; version?: string };
				expect(defaultResult.pid).toBe(daemon.pid);
				expect(defaultResult.version).toBeString();

				const httpPing = await runCli(fixture, [
					"daemon",
					"ping",
					"--host",
					"127.0.0.1",
					"--port",
					String(rpcPort),
				]);
				expect(httpPing.code).toBe(0);
				expect(httpPing.stderr).toBe("");
				const httpResult = JSON.parse(httpPing.stdout) as { pid?: number; version?: string };
				expect(httpResult.pid).toBe(daemon.pid);
				expect(httpResult.version).toBe(defaultResult.version);

				const tokenPath = join(fixture.stateDir, "control", "control-token");
				const oldToken = readFileSync(tokenPath, "utf-8").trim();
				const rotate = await runCli(fixture, ["daemon", "rotate-token", "--port", String(rpcPort)]);
				expect(rotate.code).toBe(0);
				expect(rotate.stderr).toBe("");
				const rotateResult = JSON.parse(rotate.stdout) as { token?: string; rotated?: boolean };
				expect(rotateResult.rotated).toBe(true);
				expect(rotateResult.token).toBeString();
				expect(rotateResult.token).not.toBe(oldToken);
				expect(readFileSync(tokenPath, "utf-8").trim()).toBe(rotateResult.token);
				const staleToken = await postRpcWithToken(rpcPort, oldToken);
				expect(staleToken.status).toBe(401);

				expect(apiCalls.some((call) => call.path === `/v1/agents/${ENV_ID}`)).toBe(true);
				expect(apiCalls.some((call) => call.path.startsWith("/v1/skills?"))).toBe(true);
				expect(apiCalls.some((call) => call.path === `/v1/agents/${ENV_ID}/sync-heartbeat`)).toBe(
					true,
				);
				expect(
					apiCalls.some((call) => call.path === `/v2/runtime/environments/${ENV_ID}/observations`),
				).toBe(true);
				const heartbeat = apiCalls.find(
					(call) => call.path === `/v1/agents/${ENV_ID}/sync-heartbeat`,
				);
				const observation = apiCalls.find(
					(call) => call.path === `/v2/runtime/environments/${ENV_ID}/observations`,
				);
				if (!isRecord(heartbeat?.body) || !isRecord(observation?.body)) {
					throw new Error("expected separate v1 heartbeat and v2 observation bodies");
				}
				const heartbeatBody = heartbeat.body;
				if (!isRecord(heartbeatBody.runtime_observed)) {
					throw new Error("expected legacy runtime observation in v1 heartbeat");
				}
				const legacyObserved = heartbeatBody.runtime_observed;
				expect(legacyObserved.bootSessionId).toBeUndefined();
				expect(legacyObserved.eventId).toBeUndefined();
				const observationBody = observation.body;
				expect(observationBody.bootSessionId).toBeString();
				expect(observationBody.eventId).toBeString();
				expect(existsSync(join(fixture.stateDir, "codex", "health"))).toBe(true);
				expect(apiCalls.every((call) => call.auth === `Bearer ${API_KEY}`)).toBe(true);
			} catch (error) {
				failure = error;
			} finally {
				await stopDaemon(daemon);
				const [stdout, stderr] = await Promise.all([daemonStdout, daemonStderr]);
				daemonStdoutText = stdout;
				daemonStderrText = stderr;
				rmSync(fixture.root, { recursive: true, force: true });
			}
			if (failure) {
				throw new Error(
					[
						failure instanceof Error ? failure.message : String(failure),
						"daemon stdout:",
						daemonStdoutText.trim() || "(empty)",
						"daemon stderr:",
						daemonStderrText.trim() || "(empty)",
					].join("\n"),
				);
			}
		}, 20_000);

		it("keeps v1 heartbeat healthy when v2 durable state initialization fails", async () => {
			const fixture = createFixture();
			const heartbeatRoot = join(fixture.serviceStateDir, "heartbeat");
			const environmentKey = createHash("sha256").update(ENV_ID).digest("hex");
			mkdirSync(heartbeatRoot, { recursive: true });
			writeFileSync(join(heartbeatRoot, `${environmentKey}.json`), "{corrupt-v2-state\n");
			const daemon = startDaemon(fixture);
			const daemonStdout = new Response(daemon.stdout).text();
			const daemonStderr = new Response(daemon.stderr).text();
			let failure: unknown;
			let daemonStdoutText = "";
			let daemonStderrText = "";

			try {
				await waitFor(
					() =>
						apiCalls.some((call) => call.path === `/v1/agents/${ENV_ID}/sync-heartbeat`) &&
						existsSync(join(fixture.stateDir, "codex", "health")),
				);
				const heartbeat = apiCalls.find(
					(call) => call.path === `/v1/agents/${ENV_ID}/sync-heartbeat`,
				);
				if (!isRecord(heartbeat?.body) || !isRecord(heartbeat.body.runtime_observed)) {
					throw new Error("expected frozen v1 heartbeat observation body");
				}
				expect(heartbeat.body.runtime_observed.bootSessionId).toBeUndefined();
				expect(heartbeat.body.runtime_observed.eventId).toBeUndefined();
				expect(
					apiCalls.some((call) => call.path === `/v2/runtime/environments/${ENV_ID}/observations`),
				).toBe(false);
				const exited = await Promise.race([
					daemon.exited.then(() => true),
					sleep(100).then(() => false),
				]);
				expect(exited).toBe(false);
			} catch (error) {
				failure = error;
			} finally {
				await stopDaemon(daemon);
				[daemonStdoutText, daemonStderrText] = await Promise.all([daemonStdout, daemonStderr]);
				rmSync(fixture.root, { recursive: true, force: true });
			}
			if (failure) {
				throw new Error(
					[
						failure instanceof Error ? failure.message : String(failure),
						"daemon stdout:",
						daemonStdoutText.trim() || "(empty)",
						"daemon stderr:",
						daemonStderrText.trim() || "(empty)",
					].join("\n"),
				);
			}
			expect(daemonStderrText).toContain("daemon.runtime_observation_failed");
		}, 20_000);
	});
}

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "clawdi-daemon-rpc-e2e-"));
	const home = join(root, "home");
	const clawdiHome = join(root, "clawdi-state");
	const stateDir = join(root, "serve-state");
	const serviceStateDir = join(root, "service-state");
	const runDir = join(root, "run");
	const codexHome = join(home, ".codex");
	mkdirSync(join(clawdiHome, "environments"), { recursive: true });
	mkdirSync(join(codexHome, "skills"), { recursive: true });
	mkdirSync(join(codexHome, "sessions"), { recursive: true });
	writeFileSync(
		join(clawdiHome, "environments", "codex.json"),
		`${JSON.stringify({ id: ENV_ID })}\n`,
	);
	mkdirSync(join(serviceStateDir, "status"), { recursive: true });
	writeFileSync(
		join(serviceStateDir, "status", "runtime-applied.json"),
		`${JSON.stringify({
			schemaVersion: "clawdi.runtimeAppliedState.v2",
			appliedAt: "2026-07-20T00:00:00.000Z",
			instanceId: "daemon-rpc-runtime",
			etag: '"transport-manifest"',
			manifestETag: '"frozen-manifest"',
			applyReceiptId: "apply-receipt-daemon-rpc",
			bootNonce: "boot-nonce-daemon-rpc-01",
			sourceRevision: "a".repeat(64),
			generation: 1,
			contentIdentity: {
				sourcePath: "https://runtime.test/v1/runtime/manifest",
				sha256: "b".repeat(64),
			},
			providerIds: ["managed"],
			projectedProviderIds: { codex: ["managed"] },
		})}\n`,
	);
	return { root, home, clawdiHome, stateDir, serviceStateDir, runDir, codexHome };
}

function startDaemon(fixture: Fixture): ReturnType<typeof Bun.spawn> {
	return Bun.spawn(
		[process.execPath, srcEntry, "daemon", "run", "--host", "127.0.0.1", "--port", "0"],
		{
			cwd: fixture.root,
			stdout: "pipe",
			stderr: "pipe",
			env: cliEnv(fixture),
		},
	);
}

async function runCli(
	fixture: Fixture,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn([process.execPath, srcEntry, ...args], {
		cwd: fixture.root,
		stdout: "pipe",
		stderr: "pipe",
		env: cliEnv(fixture),
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

function cliEnv(fixture: Fixture): Record<string, string> {
	return {
		CLAWDI_API_URL: server.url.origin,
		CLAWDI_AUTH_TOKEN: API_KEY,
		CLAWDI_ENVIRONMENT_ID: ENV_ID,
		CLAWDI_HOME: fixture.clawdiHome,
		CLAWDI_NO_AUTO_UPDATE: "1",
		CLAWDI_NO_UPDATE_CHECK: "1",
		CLAWDI_SERVE_MODE: "container",
		CLAWDI_RUNTIME_MODE: "hosted",
		CLAWDI_RUNTIME_HOME: fixture.home,
		CLAWDI_RUNTIME_GENERATION: "1",
		CLAWDI_RUNTIME_MANIFEST_ETAG: '"frozen-manifest"',
		CLAWDI_RUNTIME_APPLY_RECEIPT_ID: "apply-receipt-daemon-rpc",
		CLAWDI_RUNTIME_BOOT_NONCE: "boot-nonce-daemon-rpc-01",
		CLAWDI_RUN_DIR: fixture.runDir,
		CLAWDI_SERVICE_STATE_DIR: fixture.serviceStateDir,
		CLAWDI_STATE_DIR: fixture.stateDir,
		CODEX_HOME: fixture.codexHome,
		CI: "true",
		HOME: fixture.home,
		NO_COLOR: "1",
		PATH: process.env.PATH ?? "",
		TMPDIR: tmpdir(),
	};
}

async function stopDaemon(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
	proc.kill("SIGTERM");
	await withTimeout(proc.exited, 3_000).catch(async () => {
		proc.kill("SIGKILL");
		await proc.exited;
	});
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(25);
	}
	throw new Error("Timed out waiting for daemon RPC readiness");
}

async function waitForHttpUnauthorized(port: number): Promise<void> {
	await waitFor(async () => {
		try {
			const response = await postRpcWithoutToken(port);
			return response.status === 401;
		} catch {
			return false;
		}
	});
}

async function waitForRpcListening(
	stream: ReadableStream<Uint8Array>,
	timeoutMs = 10_000,
): Promise<number> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const remainingMs = Math.max(1, deadline - Date.now());
			const read = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("timeout")), remainingMs);
				}),
			]);
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (read.done) break;
			buffer += decoder.decode(read.value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const port = rpcListeningPort(line);
				if (port !== null) return port;
			}
		}
		throw new Error("Timed out waiting for daemon RPC listening log");
	} finally {
		if (timer) clearTimeout(timer);
		reader.releaseLock();
	}
}

function rpcListeningPort(line: string): number | null {
	if (!line.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || parsed.event !== "serve.rpc_listening") return null;
	const http = parsed.http;
	if (!isRecord(http) || typeof http.port !== "number") return null;
	return http.port;
}

async function postRpcWithoutToken(port: number): Promise<{ status: number; body: string }> {
	return await postRpc(port);
}

async function postRpcWithToken(
	port: number,
	token: string,
): Promise<{ status: number; body: string }> {
	return await postRpc(port, token);
}

function postRpc(port: number, token?: string): Promise<{ status: number; body: string }> {
	const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: "127.0.0.1",
				port,
				path: "/rpc",
				method: "POST",
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				let responseBody = "";
				res.setEncoding("utf-8");
				res.on("data", (chunk) => {
					responseBody += chunk;
				});
				res.on("end", () => {
					resolve({ status: res.statusCode ?? 0, body: responseBody });
				});
			},
		);
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function sse(): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			sseControllers.push(controller);
			controller.enqueue(new TextEncoder().encode(": connected\n\n"));
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		},
	});
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json",
			...headers,
		},
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonBody(req: Request): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		return undefined;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
