import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configuredNativeBinary,
	createNativeReleaseFixture,
	derivedNativeFixtureVersions,
	deriveNativeVersion,
	readNativeIdentity,
	runNativeInstaller,
} from "./native-fixture";

const nativeBinary = configuredNativeBinary();
const ENV_ID = "env-native-daemon";
const PROJECT_ID = "project-native-daemon";
const API_KEY = "native-daemon-key";

let api: ReturnType<typeof Bun.serve>;
const sseControllers: ReadableStreamDefaultController<Uint8Array>[] = [];

beforeAll(() => {
	if (!nativeBinary || process.platform !== "linux") return;
	api = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === `/v1/agents/${ENV_ID}`) {
				return Response.json({ id: ENV_ID, default_project_id: PROJECT_ID });
			}
			if (request.method === "GET" && url.pathname === "/v1/skills") {
				return Response.json({ items: [], total: 0, page: 1, page_size: 200 });
			}
			if (request.method === "GET" && url.pathname === "/v1/sync/events") {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						sseControllers.push(controller);
						controller.enqueue(new TextEncoder().encode(": connected\n\n"));
					},
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			}
			if (request.method === "POST" && url.pathname === `/v1/agents/${ENV_ID}/sync-heartbeat`) {
				return new Response(null, { status: 204 });
			}
			if (request.method === "POST" && url.pathname.includes("/observations")) {
				return Response.json({ detail: "not needed for smoke" }, { status: 503 });
			}
			return Response.json({ detail: "not found" }, { status: 404 });
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
	api?.stop(true);
});

const nativeDescribe = nativeBinary && process.platform === "linux" ? describe : describe.skip;

nativeDescribe("native daemon invocation smoke", () => {
	it("installs through a fake supervisor and executes one nested command RPC", async () => {
		if (!nativeBinary) throw new Error("native binary is required");
		const root = mkdtempSync(join(tmpdir(), "clawdi-native-daemon-"));
		const home = join(root, "home");
		const clawdiHome = join(root, "clawdi-home");
		const stateDir = join(root, "serve-state");
		const codexHome = join(home, ".codex");
		const supervisorBin = join(root, "supervisor-bin");
		const supervisorLog = join(root, "systemctl.log");
		const prefix = join(root, "prefix");
		mkdirSync(join(clawdiHome, "environments"), { recursive: true });
		mkdirSync(join(codexHome, "skills"), { recursive: true });
		mkdirSync(join(codexHome, "sessions"), { recursive: true });
		mkdirSync(supervisorBin, { recursive: true });
		writeFileSync(
			join(clawdiHome, "environments", "codex.json"),
			`${JSON.stringify({ id: ENV_ID, agentType: "codex" })}\n`,
		);
		const systemctl = join(supervisorBin, "systemctl");
		writeFileSync(systemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${supervisorLog}'\nexit 0\n`, {
			mode: 0o755,
		});
		chmodSync(systemctl, 0o755);
		const currentIdentity = readNativeIdentity(nativeBinary);
		const [oldVersion] = derivedNativeFixtureVersions(currentIdentity.version, 1);
		if (!oldVersion) throw new Error("old native fixture version is required");
		const oldBinary = join(root, `clawdi-${oldVersion}`);
		deriveNativeVersion(nativeBinary, oldBinary, oldVersion);
		const oldRelease = createNativeReleaseFixture({
			root,
			binary: oldBinary,
			resourceRoot: join(nativeBinary, ".."),
		});
		const installation = runNativeInstaller({
			fixture: oldRelease,
			prefix,
			home,
			clawdiHome,
			testRoot: root,
		});
		expect(installation.code, installation.stderr).toBe(0);
		const stableLauncher = join(prefix, "bin", "clawdi");
		expect((await runBinary(stableLauncher, ["--version"], {}, root)).stdout.trim()).toBe(
			oldVersion,
		);

		const env = {
			CLAWDI_API_URL: api.url.origin,
			CLAWDI_AUTH_TOKEN: API_KEY,
			CLAWDI_AUTH_TOKEN_ORIGIN: api.url.origin,
			CLAWDI_HOME: clawdiHome,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
			CLAWDI_SERVE_MODE: "container",
			CLAWDI_STATE_DIR: stateDir,
			CODEX_HOME: codexHome,
			HOME: home,
			NO_COLOR: "1",
			PATH: `${supervisorBin}:${process.env.PATH ?? ""}`,
			TMPDIR: tmpdir(),
		};

		let daemon: ReturnType<typeof Bun.spawn> | null = null;
		let daemonStdout = "";
		let daemonStderr = "";
		try {
			const installed = await runBinary(
				stableLauncher,
				["daemon", "install", "--host", "127.0.0.1", "--port", "0"],
				env,
				root,
			);
			if (installed.code !== 0) {
				throw new Error(
					`native daemon install exited ${installed.code}\nstdout:\n${installed.stdout}\nstderr:\n${installed.stderr}`,
				);
			}
			expect(installed.stdout).toContain("Installed singleton daemon unit");
			expect(readFileSync(supervisorLog, "utf-8")).toContain(
				"--user enable --now clawdi-serve.service",
			);

			const unitPath = join(home, ".config", "systemd", "user", "clawdi-serve.service");
			expect(existsSync(unitPath)).toBe(true);
			const execStart = readFileSync(unitPath, "utf-8").match(/^ExecStart=(.+)$/m)?.[1];
			expect(execStart).toBe(`${stableLauncher} daemon run`);
			const currentRelease = createNativeReleaseFixture({
				root,
				binary: nativeBinary,
				resourceRoot: join(nativeBinary, ".."),
			});
			const upgraded = runNativeInstaller({
				fixture: currentRelease,
				prefix,
				home,
				clawdiHome,
				testRoot: root,
			});
			expect(upgraded.code, upgraded.stderr).toBe(0);
			expect((await runBinary(stableLauncher, ["--version"], {}, root)).stdout.trim()).toBe(
				currentIdentity.version,
			);
			expect(readFileSync(unitPath, "utf8")).toContain(`ExecStart=${stableLauncher} daemon run`);

			// The harness acts as the isolated supervisor and launches the exact
			// command written by daemon install.
			daemon = Bun.spawn([stableLauncher, "daemon", "run"], {
				cwd: root,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdoutPromise = new Response(daemon.stdout).text();
			const [readyStream, stderrStream] = daemon.stderr.tee();
			const stderrPromise = new Response(stderrStream).text();
			const port = await waitForRpcPort(readyStream);
			await waitFor(() => existsSync(join(stateDir, "control", "control-token")));
			const token = readFileSync(join(stateDir, "control", "control-token"), "utf-8").trim();
			const rpcResponse = await fetch(`http://127.0.0.1:${port}/rpc`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "sync.push_dry_run",
					params: { agent: "codex", cwd: root, modules: "skills" },
				}),
			});
			const rpc = (await rpcResponse.json()) as {
				error?: { message?: string };
				result?: { exit_code?: number; stdout?: string };
			};
			expect(rpc.error).toBeUndefined();
			expect(rpc.result?.exit_code).toBe(0);
			expect(rpc.result?.stdout).toContain("Dry run");

			daemon.kill("SIGTERM");
			await withTimeout(daemon.exited, 5_000);
			[daemonStdout, daemonStderr] = await Promise.all([stdoutPromise, stderrPromise]);
			daemon = null;
		} catch (error) {
			if (daemon) {
				daemon.kill("SIGKILL");
				await daemon.exited;
			}
			throw new Error(
				[
					error instanceof Error ? error.message : String(error),
					"daemon stdout:",
					daemonStdout || "(empty)",
					"daemon stderr:",
					daemonStderr || "(empty)",
				].join("\n"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});

async function runBinary(
	binary: string,
	args: string[],
	env: Record<string, string>,
	cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const process = Bun.spawn([binary, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { code, stdout, stderr };
}

async function waitForRpcPort(stream: ReadableStream<Uint8Array>): Promise<number> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		return await withTimeout(
			(async () => {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) throw new Error("daemon exited before RPC became ready");
					buffer += decoder.decode(chunk.value, { stream: true });
					for (const line of buffer.split("\n")) {
						if (!line.includes('"event":"serve.rpc_listening"')) continue;
						const parsed = JSON.parse(line) as { http?: { port?: number } };
						if (parsed.http?.port !== undefined) return parsed.http.port;
					}
				}
			})(),
			10_000,
		);
	} finally {
		reader.releaseLock();
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(25);
	}
	throw new Error("timed out waiting for native daemon state");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
