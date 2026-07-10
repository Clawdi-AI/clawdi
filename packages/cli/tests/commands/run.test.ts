import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRuntimeChildSpawn, run } from "../../src/commands/run";
import { setProjectFolderLink } from "../../src/lib/project-folders";
import { jsonResponse, mockFetch } from "./helpers";

interface SpawnCall {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd?: string;
}

let tmpRoot: string;
let fakeClawdiHome: string;
let projectRoot: string;
let projectChild: string;
let origEnv: Record<string, string | undefined>;
let origCwd: string;

beforeEach(() => {
	origEnv = { ...process.env };
	origCwd = process.cwd();

	tmpRoot = join(tmpdir(), `clawdi-run-${Date.now()}-${Math.random().toString(36)}`);
	fakeClawdiHome = join(tmpRoot, "state");
	projectRoot = join(tmpRoot, "project");
	projectChild = join(projectRoot, "src");
	mkdirSync(fakeClawdiHome, { recursive: true });
	mkdirSync(projectChild, { recursive: true });
	writeFileSync(join(fakeClawdiHome, "auth.json"), JSON.stringify({ apiKey: "test-key" }));

	process.env.HOME = join(tmpRoot, "home");
	process.env.CLAWDI_HOME = fakeClawdiHome;
	delete process.env.CLAWDI_AUTH_TOKEN;
	process.env.CLAWDI_API_URL = "http://api.test";
	process.chdir(projectChild);
});

afterEach(() => {
	process.chdir(origCwd);
	restoreEnv(origEnv);
	rmSync(tmpRoot, { recursive: true, force: true });
	process.exitCode = undefined;
});

function restoreEnv(snapshot: Record<string, string | undefined>): void {
	for (const key of Object.keys(process.env)) {
		if (!(key in snapshot)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(snapshot)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function recordSpawn(opts: { autoExit?: boolean } = {}): {
	calls: SpawnCall[];
	children: ChildProcess[];
	spawnImpl: NonNullable<Parameters<typeof run>[2]>;
} {
	const calls: SpawnCall[] = [];
	const children: ChildProcess[] = [];
	const spawnImpl = ((command: string, args: string[], options: SpawnOptions) => {
		calls.push({
			command,
			args,
			env: (options.env ?? {}) as NodeJS.ProcessEnv,
			cwd: typeof options.cwd === "string" ? options.cwd : undefined,
		});
		const child = new EventEmitter() as ChildProcess;
		children.push(child);
		if (opts.autoExit !== false) {
			queueMicrotask(() => child.emit("exit", 0));
		}
		return child;
	}) as NonNullable<Parameters<typeof run>[2]>;
	return { calls, children, spawnImpl };
}

function linkCurrentProjectFolder(): void {
	setProjectFolderLink(projectRoot, {
		project_id: "project-linked",
		project_label: "engineering",
		project_name: "Engineering",
		project_slug: "engineering",
		owner_handle: null,
		owner_display: null,
	});
}

describe("run command project folder selection", () => {
	it("drops root-hosted runtime children to CLAWDI_RUNTIME_USER", () => {
		const child = buildRuntimeChildSpawn(
			{
				runtime: "openclaw",
				service: null,
				command: "/home/clawdi/.openclaw/bin/openclaw",
				args: ["gateway", "run"],
				cwd: "/home/clawdi/clawdi",
				env: {
					HOME: "/home/clawdi",
					CLAWDI_RUNTIME_USER: "clawdi",
					CLAWDI_AUTH_TOKEN: "runtime-auth-token",
					CLAWDI_EGRESS_SECRET_FILE: "/run/clawdi/secrets/egress-secrets.json",
					HTTPS_PROXY: "http://127.0.0.1:19090",
					CLAWDI_PROVIDER_PLACEHOLDER_TOKEN: "clawdi-egress-placeholder",
				},
				configPath: "/var/lib/clawdi/config/run/openclaw.json",
			},
			{ isRoot: true, commandExists: (command) => command === "gosu" },
		);

		expect(child.command).toBe("gosu");
		expect(child.args).toEqual(["clawdi", "/home/clawdi/.openclaw/bin/openclaw", "gateway", "run"]);
		expect(child.env.USER).toBe("clawdi");
		expect(child.env.LOGNAME).toBe("clawdi");
		expect(child.env.HOME).toBe("/home/clawdi");
		expect(child.env.HTTPS_PROXY).toBe("http://127.0.0.1:19090");
		expect(child.env.CLAWDI_PROVIDER_PLACEHOLDER_TOKEN).toBe("clawdi-egress-placeholder");
		expect(child.env.CLAWDI_AUTH_TOKEN).toBeUndefined();
		expect(child.env.CLAWDI_EGRESS_SECRET_FILE).toBeUndefined();
	});

	it("preserves runtime env when falling back to runuser", () => {
		const child = buildRuntimeChildSpawn(
			{
				runtime: "hermes",
				service: null,
				command: "/home/clawdi/.local/bin/hermes",
				args: ["dashboard"],
				cwd: "/home/clawdi/clawdi",
				env: {
					HOME: "/home/clawdi",
					PATH: "/home/clawdi/.local/bin:/usr/bin",
					CLAWDI_RUNTIME_USER: "clawdi",
					CLAWDI_AUTH_TOKEN: "runtime-auth-token",
					CLAWDI_EGRESS_SECRET_FILE: "/run/clawdi/secrets/egress-secrets.json",
					HTTPS_PROXY: "http://127.0.0.1:19090",
					SSL_CERT_FILE: "/run/clawdi/egress-scratch/sidecars/test/ca.pem",
				},
				configPath: "/var/lib/clawdi/config/run/hermes.json",
			},
			{ isRoot: true, commandExists: (command) => command === "runuser" },
		);

		expect(child.command).toBe("runuser");
		expect(child.args).toEqual([
			"--preserve-environment",
			"-u",
			"clawdi",
			"--",
			"/home/clawdi/.local/bin/hermes",
			"dashboard",
		]);
		expect(child.env.USER).toBe("clawdi");
		expect(child.env.LOGNAME).toBe("clawdi");
		expect(child.env.PATH).toBe("/home/clawdi/.local/bin:/usr/bin");
		expect(child.env.HTTPS_PROXY).toBe("http://127.0.0.1:19090");
		expect(child.env.SSL_CERT_FILE).toBe("/run/clawdi/egress-scratch/sidecars/test/ca.pem");
		expect(child.env.CLAWDI_AUTH_TOKEN).toBeUndefined();
		expect(child.env.CLAWDI_EGRESS_SECRET_FILE).toBeUndefined();
	});

	it("fails closed when root-hosted runtime cannot drop privileges", () => {
		expect(() =>
			buildRuntimeChildSpawn(
				{
					runtime: "openclaw",
					service: null,
					command: "openclaw",
					args: [],
					cwd: "/home/clawdi/clawdi",
					env: { CLAWDI_RUNTIME_USER: "clawdi" },
					configPath: "/var/lib/clawdi/config/run/openclaw.json",
				},
				{ isRoot: true, commandExists: () => false },
			),
		).toThrow("neither gosu nor runuser is available");
	});

	it("runs hosted runtime commands from managed run config without login", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const hermesPath = join(tmpRoot, "home", "clawdi", ".local", "bin", "hermes");
		const runConfigRoot = join(serviceStateRoot, "config", "run");
		mkdirSync(runConfigRoot, { recursive: true });
		mkdirSync(join(tmpRoot, "home", "clawdi", ".local", "bin"), { recursive: true });
		writeFileSync(
			join(runConfigRoot, "hermes.json"),
			JSON.stringify({
				schemaVersion: "clawdi.runtimeRunConfig.v1",
				runtime: "hermes",
				enabled: true,
				generatedAt: "2026-06-04T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				command: "hermes",
				defaultArgs: ["--no-browser"],
				env: {
					DISCORD_API_BASE_URL: "http://127.0.0.1:4500/discord",
				},
				prependPath: [join(tmpRoot, "home", "clawdi", ".local", "bin")],
				cwd: projectRoot,
				commandPath: hermesPath,
				appRoot: join(tmpRoot, "home", "clawdi", ".hermes", "hermes-agent"),
			}),
		);
		writeFileSync(hermesPath, "#!/usr/bin/env sh\n");
		const { calls, spawnImpl } = recordSpawn();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		delete process.env.CLAWDI_AUTH_TOKEN;

		await run(["hermes", "--version"], {}, spawnImpl);

		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe(hermesPath);
		expect(calls[0].args).toEqual(["--version"]);
		expect(calls[0].cwd).toBe(projectRoot);
		expect(calls[0].env.DISCORD_API_BASE_URL).toBe("http://127.0.0.1:4500/discord");
		expect(calls[0].env.PATH?.startsWith(join(tmpRoot, "home", "clawdi", ".local", "bin"))).toBe(
			true,
		);
	});

	it("runs hosted runtime services from managed service run config", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const hermesPath = join(tmpRoot, "home", "clawdi", ".local", "bin", "hermes");
		const runConfigRoot = join(serviceStateRoot, "config", "run");
		mkdirSync(runConfigRoot, { recursive: true });
		mkdirSync(join(tmpRoot, "home", "clawdi", ".local", "bin"), { recursive: true });
		writeFileSync(
			join(runConfigRoot, "hermes+dashboard.json"),
			JSON.stringify({
				schemaVersion: "clawdi.runtimeRunConfig.v1",
				runtime: "hermes",
				service: "dashboard",
				enabled: true,
				generatedAt: "2026-07-01T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				command: "hermes",
				defaultArgs: ["dashboard", "--host", "127.0.0.1", "--port", "9119", "--no-open"],
				env: {
					HERMES_CONFIG: "/home/clawdi/.hermes/config.toml",
				},
				prependPath: [join(tmpRoot, "home", "clawdi", ".local", "bin")],
				cwd: projectRoot,
				commandPath: hermesPath,
				appRoot: join(tmpRoot, "home", "clawdi", ".hermes", "hermes-agent"),
			}),
		);
		writeFileSync(hermesPath, "#!/usr/bin/env sh\n");
		const { calls, spawnImpl } = recordSpawn();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		delete process.env.CLAWDI_AUTH_TOKEN;

		await run(["hermes"], { runtimeService: "hermes+dashboard" }, spawnImpl);

		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe(hermesPath);
		expect(calls[0].args).toEqual([
			"dashboard",
			"--host",
			"127.0.0.1",
			"--port",
			"9119",
			"--no-open",
		]);
		expect(calls[0].cwd).toBe(projectRoot);
		expect(calls[0].env.HERMES_CONFIG).toBe("/home/clawdi/.hermes/config.toml");
	});

	it("rejects disabled hosted runtime commands before native binaries can run", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const hermesPath = join(tmpRoot, "home", "clawdi", ".local", "bin", "hermes");
		const runConfigRoot = join(serviceStateRoot, "config", "run");
		mkdirSync(runConfigRoot, { recursive: true });
		mkdirSync(join(tmpRoot, "home", "clawdi", ".local", "bin"), { recursive: true });
		writeFileSync(
			join(runConfigRoot, "hermes.json"),
			JSON.stringify({
				schemaVersion: "clawdi.runtimeRunConfig.v1",
				runtime: "hermes",
				enabled: false,
				generatedAt: "2026-06-25T00:00:00Z",
				generation: 2,
				instanceId: "iid_test",
				command: "hermes",
				defaultArgs: [],
				env: {},
				prependPath: [join(tmpRoot, "home", "clawdi", ".local", "bin")],
				cwd: projectRoot,
				commandPath: hermesPath,
				appRoot: join(tmpRoot, "home", "clawdi", ".hermes", "hermes-agent"),
			}),
		);
		writeFileSync(hermesPath, "#!/usr/bin/env sh\n");
		const { calls, spawnImpl } = recordSpawn();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;

		const originalExit = process.exit;
		const originalLog = console.log;
		const logs: string[] = [];
		process.exit = ((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? 0}`);
		}) as typeof process.exit;
		console.log = (message?: unknown) => {
			logs.push(String(message ?? ""));
		};
		try {
			await expect(run(["hermes"], {}, spawnImpl)).rejects.toThrow("process.exit:1");
		} finally {
			console.log = originalLog;
			process.exit = originalExit;
		}

		expect(calls).toHaveLength(0);
		expect(logs.join("\n")).toContain("Runtime hermes is disabled");
	});

	it("uses hosted runtime provider placeholders without exposing managed secrets", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const openclawPath = join(tmpRoot, "home", "clawdi", ".openclaw", "bin", "openclaw");
		const runConfigRoot = join(serviceStateRoot, "config", "run");
		mkdirSync(runConfigRoot, { recursive: true });
		mkdirSync(join(tmpRoot, "home", "clawdi", ".openclaw", "bin"), { recursive: true });
		writeFileSync(
			join(runConfigRoot, "openclaw.json"),
			JSON.stringify({
				schemaVersion: "clawdi.runtimeRunConfig.v1",
				runtime: "openclaw",
				enabled: true,
				generatedAt: "2026-06-22T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				command: "openclaw",
				defaultArgs: ["gateway", "run"],
				env: {
					CLAWDI_MANAGED_OPENAI_API_KEY: "clawdi-egress-placeholder",
				},
				secretEnv: {},
				secretFilePath: null,
				prependPath: [join(tmpRoot, "home", "clawdi", ".openclaw", "bin")],
				cwd: projectRoot,
				commandPath: openclawPath,
				appRoot: join(tmpRoot, "home", "clawdi", ".openclaw"),
				egressProfileBundlePath: null,
			}),
		);
		writeFileSync(openclawPath, "#!/usr/bin/env sh\n");
		const { calls, spawnImpl } = recordSpawn();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		process.env.CLAWDI_AUTH_TOKEN = "hosted-runtime-token";

		await run(["openclaw"], {}, spawnImpl);

		expect(calls).toHaveLength(1);
		expect(calls[0].args).toEqual(["gateway", "run"]);
		expect(calls[0].env.CLAWDI_MANAGED_OPENAI_API_KEY).toBe("clawdi-egress-placeholder");
		expect(calls[0].env.CLAWDI_AUTH_TOKEN).toBeUndefined();
		expect(calls[0].env.CLAWDI_EGRESS_SECRET_FILE).toBeUndefined();
	});

	it("does not prepend managed runtime default args to hosted runtime subcommands", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const openclawPath = join(tmpRoot, "home", "clawdi", ".openclaw", "bin", "openclaw");
		const runConfigRoot = join(serviceStateRoot, "config", "run");
		mkdirSync(runConfigRoot, { recursive: true });
		mkdirSync(join(tmpRoot, "home", "clawdi", ".openclaw", "bin"), { recursive: true });
		writeFileSync(
			join(runConfigRoot, "openclaw.json"),
			JSON.stringify({
				schemaVersion: "clawdi.runtimeRunConfig.v1",
				runtime: "openclaw",
				enabled: true,
				generatedAt: "2026-06-25T00:00:00Z",
				generation: 2,
				instanceId: "iid_test",
				command: "openclaw",
				defaultArgs: ["gateway", "run", "--auth", "none"],
				env: {},
				secretEnv: {},
				secretFilePath: null,
				prependPath: [join(tmpRoot, "home", "clawdi", ".openclaw", "bin")],
				cwd: projectRoot,
				commandPath: openclawPath,
				appRoot: join(tmpRoot, "home", "clawdi", ".openclaw"),
				egressProfileBundlePath: null,
			}),
		);
		writeFileSync(openclawPath, "#!/usr/bin/env sh\n");
		const { calls, spawnImpl } = recordSpawn();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;

		await run(["openclaw", "agent", "--local"], {}, spawnImpl);

		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe(openclawPath);
		expect(calls[0].args).toEqual(["agent", "--local"]);
	});

	it("keeps hosted runtime wrapper alive until the child exits", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const hermesPath = join(tmpRoot, "home", "clawdi", ".local", "bin", "hermes");
		const runConfigRoot = join(serviceStateRoot, "config", "run");
		mkdirSync(runConfigRoot, { recursive: true });
		mkdirSync(join(tmpRoot, "home", "clawdi", ".local", "bin"), { recursive: true });
		writeFileSync(
			join(runConfigRoot, "hermes.json"),
			JSON.stringify({
				schemaVersion: "clawdi.runtimeRunConfig.v1",
				runtime: "hermes",
				enabled: true,
				generatedAt: "2026-06-08T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				command: "hermes",
				defaultArgs: [],
				env: {},
				prependPath: [join(tmpRoot, "home", "clawdi", ".local", "bin")],
				cwd: projectRoot,
				commandPath: hermesPath,
				appRoot: join(tmpRoot, "home", "clawdi", ".hermes", "hermes-agent"),
			}),
		);
		writeFileSync(hermesPath, "#!/usr/bin/env sh\n");
		const { calls, children, spawnImpl } = recordSpawn({ autoExit: false });
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		delete process.env.CLAWDI_AUTH_TOKEN;

		let resolved = false;
		const running = run(["hermes"], {}, spawnImpl).then(() => {
			resolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(calls).toHaveLength(1);
		expect(resolved).toBe(false);

		children[0].emit("exit", 0);
		await running;
		expect(resolved).toBe(true);
		expect(process.exitCode).toBe(0);
	});

	it("reports signal-terminated hosted runtime children as failures", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const hermesPath = join(tmpRoot, "home", "clawdi", ".local", "bin", "hermes");
		const runConfigRoot = join(serviceStateRoot, "config", "run");
		mkdirSync(runConfigRoot, { recursive: true });
		mkdirSync(join(tmpRoot, "home", "clawdi", ".local", "bin"), { recursive: true });
		writeFileSync(
			join(runConfigRoot, "hermes.json"),
			JSON.stringify({
				schemaVersion: "clawdi.runtimeRunConfig.v1",
				runtime: "hermes",
				enabled: true,
				generatedAt: "2026-06-08T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				command: "hermes",
				defaultArgs: [],
				env: {},
				prependPath: [join(tmpRoot, "home", "clawdi", ".local", "bin")],
				cwd: projectRoot,
				commandPath: hermesPath,
				appRoot: join(tmpRoot, "home", "clawdi", ".hermes", "hermes-agent"),
			}),
		);
		writeFileSync(hermesPath, "#!/usr/bin/env sh\n");
		const { children, spawnImpl } = recordSpawn({ autoExit: false });
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		delete process.env.CLAWDI_AUTH_TOKEN;

		const running = run(["hermes"], {}, spawnImpl);
		await new Promise((resolve) => setTimeout(resolve, 20));
		children[0].emit("exit", null, "SIGTERM");
		await running;

		expect(process.exitCode).toBe(143);
	});

	it("applies transparent egress CA env for hosted runtime commands with profile bundles", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const hermesPath = join(tmpRoot, "home", "clawdi", ".local", "bin", "hermes");
		const runConfigRoot = join(serviceStateRoot, "config", "run");
		const egressProfileBundle = join(serviceStateRoot, "config", "egress", "profiles.json");
		mkdirSync(runConfigRoot, { recursive: true });
		mkdirSync(join(serviceStateRoot, "config", "egress"), { recursive: true });
		mkdirSync(join(tmpRoot, "home", "clawdi", ".local", "bin"), { recursive: true });
		writeFileSync(egressProfileBundle, "{}\n");
		writeFileSync(
			join(runConfigRoot, "hermes.json"),
			JSON.stringify({
				schemaVersion: "clawdi.runtimeRunConfig.v1",
				runtime: "hermes",
				enabled: true,
				generatedAt: "2026-06-04T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				command: "hermes",
				defaultArgs: ["--no-browser"],
				env: {},
				prependPath: [join(tmpRoot, "home", "clawdi", ".local", "bin")],
				cwd: projectRoot,
				commandPath: hermesPath,
				appRoot: join(tmpRoot, "home", "clawdi", ".hermes", "hermes-agent"),
				egressProfileBundlePath: egressProfileBundle,
			}),
		);
		writeFileSync(hermesPath, "#!/usr/bin/env sh\n");
		const { calls, spawnImpl } = recordSpawn();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		process.env.CLAWDI_AUTH_TOKEN = "hosted-runtime-token";

		await run(["hermes", "serve"], {}, spawnImpl);

		expect(calls).toHaveLength(1);
		expect(calls[0].env.CLAWDI_EGRESS_ENABLED).toBeUndefined();
		expect(calls[0].env.CLAWDI_EGRESS_PROFILE_BUNDLE).toBeUndefined();
		expect(calls[0].env.CLAWDI_EGRESS_SECRET_FILE).toBeUndefined();
		expect(calls[0].env.CLAWDI_EGRESS_PROXY_URL).toBeUndefined();
		expect(calls[0].env.HTTPS_PROXY).toBeUndefined();
		expect(calls[0].env.HTTP_PROXY).toBeUndefined();
		expect(calls[0].env.https_proxy).toBeUndefined();
		expect(calls[0].env.http_proxy).toBeUndefined();
		expect(calls[0].env.NO_PROXY).toBeUndefined();
		expect(calls[0].env.no_proxy).toBeUndefined();
		expect(calls[0].env.NODE_USE_ENV_PROXY).toBeUndefined();
		expect(calls[0].env.OPENCLAW_PROXY_URL).toBeUndefined();
		expect(calls[0].env.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(calls[0].env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(calls[0].env.REQUESTS_CA_BUNDLE).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(calls[0].env.CURL_CA_BUNDLE).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(calls[0].env.GIT_SSL_CAINFO).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(calls[0].env.DENO_CERT).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(calls[0].env.CODEX_CA_CERTIFICATE).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(calls[0].env.CLAWDI_PROVIDER_PLACEHOLDER_TOKEN).toBe("clawdi-egress-placeholder");
		expect(calls[0].env.CLAWDI_EGRESS_SIDECAR_PATH).toBeUndefined();
		expect(calls[0].env.CLAWDI_EGRESS_SIDECAR_BUNDLE).toBeUndefined();
		expect(calls[0].env.CLAWDI_EGRESS_ALLOW_REMOTE_PROXY).toBeUndefined();
		expect(calls[0].env.CLAWDI_AUTH_TOKEN).toBeUndefined();
	});

	it("does not start a per-run hosted egress sidecar for transparent runtime commands", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const hermesPath = join(tmpRoot, "home", "clawdi", ".local", "bin", "hermes");
		const runConfigRoot = join(serviceStateRoot, "config", "run");
		const egressProfileBundle = join(serviceStateRoot, "config", "egress", "profiles.json");
		mkdirSync(runConfigRoot, { recursive: true });
		mkdirSync(join(serviceStateRoot, "config", "egress"), { recursive: true });
		mkdirSync(join(tmpRoot, "home", "clawdi", ".local", "bin"), { recursive: true });
		writeFileSync(egressProfileBundle, "{}\n");
		writeFileSync(
			join(runConfigRoot, "hermes.json"),
			JSON.stringify({
				schemaVersion: "clawdi.runtimeRunConfig.v1",
				runtime: "hermes",
				enabled: true,
				generatedAt: "2026-06-04T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				command: "hermes",
				defaultArgs: [],
				env: {},
				prependPath: [join(tmpRoot, "home", "clawdi", ".local", "bin")],
				cwd: projectRoot,
				commandPath: hermesPath,
				appRoot: join(tmpRoot, "home", "clawdi", ".hermes", "hermes-agent"),
				egressProfileBundlePath: egressProfileBundle,
			}),
		);
		writeFileSync(hermesPath, "#!/usr/bin/env sh\n");
		const { calls, spawnImpl } = recordSpawn();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;

		await run(["hermes", "serve"], {}, spawnImpl);

		expect(calls).toHaveLength(1);
	});

	it("uses the system CA bundle for hosted transparent runtime commands", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const hermesPath = join(tmpRoot, "home", "clawdi", ".local", "bin", "hermes");
		const runConfigRoot = join(serviceStateRoot, "config", "run");
		const egressProfileBundle = join(serviceStateRoot, "config", "egress", "profiles.json");
		mkdirSync(runConfigRoot, { recursive: true });
		mkdirSync(join(serviceStateRoot, "config", "egress"), { recursive: true });
		mkdirSync(join(tmpRoot, "home", "clawdi", ".local", "bin"), { recursive: true });
		writeFileSync(
			egressProfileBundle,
			JSON.stringify({
				schemaVersion: "clawdi.egressProfiles.v1",
				generatedAt: "2026-06-04T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				profiles: [],
			}),
		);
		writeFileSync(
			join(runConfigRoot, "hermes.json"),
			JSON.stringify({
				schemaVersion: "clawdi.runtimeRunConfig.v1",
				runtime: "hermes",
				enabled: true,
				generatedAt: "2026-06-04T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				command: "hermes",
				defaultArgs: [],
				env: {},
				prependPath: [join(tmpRoot, "home", "clawdi", ".local", "bin")],
				cwd: projectRoot,
				commandPath: hermesPath,
				appRoot: join(tmpRoot, "home", "clawdi", ".hermes", "hermes-agent"),
				egressProfileBundlePath: egressProfileBundle,
			}),
		);
		writeFileSync(hermesPath, "#!/usr/bin/env sh\n");
		const { calls, spawnImpl } = recordSpawn();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		process.env.CLAWDI_EGRESS_PROXY_PORT = "0";
		delete process.env.CLAWDI_AUTH_TOKEN;

		try {
			await run(["hermes", "serve"], {}, spawnImpl);
		} finally {
			delete process.env.CLAWDI_EGRESS_PROXY_PORT;
		}

		expect(calls).toHaveLength(1);
		expect(calls[0].env.CLAWDI_EGRESS_PROXY_URL).toBeUndefined();
		expect(calls[0].env.HTTPS_PROXY).toBeUndefined();
		expect(calls[0].env.HTTP_PROXY).toBeUndefined();
		expect(calls[0].env.https_proxy).toBeUndefined();
		expect(calls[0].env.http_proxy).toBeUndefined();
		expect(calls[0].env.OPENCLAW_PROXY_URL).toBeUndefined();
		expect(calls[0].env.CLAWDI_EGRESS_CA_FILE).toBeUndefined();
		expect(calls[0].env.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(calls[0].env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(calls[0].env.CODEX_CA_CERTIFICATE).toBe("/etc/ssl/certs/ca-certificates.crt");
	});

	it("runs generic hosted commands with the managed egress profile bundle without login", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const egressProfileBundle = join(serviceStateRoot, "config", "egress", "profiles.json");
		mkdirSync(join(serviceStateRoot, "config", "egress"), { recursive: true });
		writeFileSync(
			egressProfileBundle,
			JSON.stringify({
				schemaVersion: "clawdi.egressProfiles.v1",
				generatedAt: "2026-06-05T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				profiles: [],
			}),
		);
		const { calls, spawnImpl } = recordSpawn();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		delete process.env.CLAWDI_AUTH_TOKEN;

		await run(["codex", "exec", "hello"], {}, spawnImpl);

		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("codex");
		expect(calls[0].args).toEqual(["exec", "hello"]);
		expect(calls[0].cwd).toBe(projectChild);
		expect(calls[0].env.CLAWDI_EGRESS_PROFILE_BUNDLE).toBeUndefined();
		expect(calls[0].env.CLAWDI_EGRESS_SECRET_FILE).toBeUndefined();
		expect(calls[0].env.HTTPS_PROXY).toBeUndefined();
		expect(calls[0].env.https_proxy).toBeUndefined();
		expect(calls[0].env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(calls[0].env.CODEX_CA_CERTIFICATE).toBe("/etc/ssl/certs/ca-certificates.crt");
	});

	it("runs generic hosted commands without login when no egress profile bundle exists", async () => {
		unlinkSync(join(fakeClawdiHome, "auth.json"));
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const { calls, spawnImpl } = recordSpawn();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		process.env.PATH = `${join(serviceStateRoot, "bin")}:/usr/local/bin:/usr/bin`;
		delete process.env.CLAWDI_AUTH_TOKEN;

		await run(["node", "--version"], {}, spawnImpl);

		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("node");
		expect(calls[0].args).toEqual(["--version"]);
		expect(calls[0].env.PATH).toBe("/usr/local/bin:/usr/bin");
	});

	it("does not inject cloud-managed AI provider keys into hosted runtime commands", async () => {
		const serviceStateRoot = join(tmpRoot, "var", "lib", "clawdi");
		const runRoot = join(tmpRoot, "run", "clawdi");
		const egressProfileBundle = join(serviceStateRoot, "config", "egress", "profiles.json");
		const catalogDir = join(fakeClawdiHome, "ai-providers");
		mkdirSync(join(serviceStateRoot, "config", "egress"), { recursive: true });
		mkdirSync(catalogDir, { recursive: true });
		writeFileSync(
			egressProfileBundle,
			JSON.stringify({
				schemaVersion: "clawdi.egressProfiles.v1",
				generatedAt: "2026-06-05T00:00:00Z",
				generation: 1,
				instanceId: "iid_test",
				profiles: [],
			}),
		);
		writeFileSync(
			join(catalogDir, "catalog.json"),
			JSON.stringify({
				schema_version: 1,
				providers: [
					{
						id: "managed-openai",
						type: "openai",
						label: "Managed OpenAI",
						base_url: "https://provider.test/v1",
						default_model: "gpt-5.5",
						api_mode: "openai_responses",
						auth: { type: "api_key", source: "managed" },
						managed_by: "user",
						runtime_env_name: "CLAWDI_OPENAI_API_KEY",
					},
				],
				defaults: { chat_provider_id: "managed-openai" },
			}),
		);
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/resolve",
				response: () => jsonResponse({ RUNTIME_VALUE: "from-vault" }),
			},
		]);
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = serviceStateRoot;
		process.env.CLAWDI_RUN_DIR = runRoot;
		try {
			await run(["codex", "exec", "hello"], { allVaultEnv: true, projectFolder: false }, spawnImpl);
		} finally {
			restore();
		}

		expect(captured.map((request) => request.path)).toEqual(["/v1/vault/resolve"]);
		expect(calls).toHaveLength(1);
		expect(calls[0].env.RUNTIME_VALUE).toBe("from-vault");
		expect(calls[0].env.CLAWDI_OPENAI_API_KEY).toBeUndefined();
		expect(calls[0].env.CLAWDI_EGRESS_SECRET_FILE).toBeUndefined();
	});

	it("uses the linked Project folder when resolving vault env", async () => {
		linkCurrentProjectFolder();
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/resolve",
				response: () => jsonResponse({ DEPLOY_TOKEN: "vault-secret" }),
			},
		]);
		const origLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await run(["npm", "run", "deploy"], { allVaultEnv: true }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].method).toBe("POST");
		expect(captured[0].path).toContain("/v1/vault/resolve");
		expect(captured[0].path).toContain("project_id=project-linked");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ command: "npm", args: ["run", "deploy"] });
		expect(calls[0].env.DEPLOY_TOKEN).toBe("vault-secret");

		const out = lines.join("\n");
		expect(out).toContain("Using Project engineering");
		expect(out).toContain("Injected 1 vault secrets");
		expect(out).not.toContain("vault-secret");
	});

	it("skips linked-folder lookup when --no-project-folder is passed", async () => {
		linkCurrentProjectFolder();
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/resolve",
				response: () => jsonResponse({ API_TOKEN: "from-default-project" }),
			},
		]);
		const origLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await run(["node", "server.js"], { projectFolder: false, allVaultEnv: true }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].path).toContain("/v1/vault/resolve");
		expect(captured[0].path).not.toContain("project_id=");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ command: "node", args: ["server.js"] });
		expect(calls[0].env.API_TOKEN).toBe("from-default-project");
		expect(lines.join("\n")).not.toContain("Using Project");
	});

	it("runs without vault injection when resolve returns an invalid body", async () => {
		const { calls, spawnImpl } = recordSpawn();
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/resolve",
				response: () =>
					new Response("null", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			},
		]);
		const origLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await run(["node", "server.js"], { projectFolder: false, allVaultEnv: true }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ command: "node", args: ["server.js"] });
		expect(lines.join("\n")).toContain("Could not fetch vault secrets");
		expect(lines.join("\n")).not.toContain("Injected");
	});

	it("explains shared Project backend drift when all-vault resolve returns project not found", async () => {
		const { calls, spawnImpl } = recordSpawn();
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/resolve",
				response: () => jsonResponse({ detail: "project not found" }, 404),
			},
		]);
		const origLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await run(["node", "server.js"], { projectFolder: false, allVaultEnv: true }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(calls).toHaveLength(1);
		const out = lines.join("\n");
		expect(out).toContain("Could not fetch vault secrets");
		expect(out).toContain("Vault resolve could not access the selected Project.");
		expect(out).toContain("shared Project");
		expect(out).toContain("update the Clawdi backend");
		expect(out).not.toContain("API error 404");
		expect(out).not.toContain("Injected");
	});

	it("resolves clawdi references from env files without all-vault injection", async () => {
		const envFile = join(tmpRoot, ".env");
		writeFileSync(
			envFile,
			["OPENAI_API_KEY=clawdi://prod/openai/api_key", "LITERAL_VALUE=kept"].join("\n"),
		);
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/resolve/bulk",
				response: () =>
					jsonResponse({
						results: {
							"clawdi://prod/openai/api_key": {
								reference: "clawdi://prod/openai/api_key",
								value: "sk-test",
								source_project_id: "project-default",
								source_alias: "project-default",
								vault_slug: "prod",
								section: "openai",
								item_name: "api_key",
							},
						},
					}),
			},
		]);
		const origLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await run(["node", "server.js"], { envFile: [envFile], projectFolder: false }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].path).toContain("/v1/vault/resolve/bulk");
		expect(captured[0].body).toMatchObject({
			references: [
				{
					reference: "clawdi://prod/openai/api_key",
					vault_slug: "prod",
					section: "openai",
					field: "api_key",
				},
			],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].env.OPENAI_API_KEY).toBe("sk-test");
		expect(calls[0].env.LITERAL_VALUE).toBe("kept");
		expect(lines.join("\n")).toContain("Resolved 1 clawdi reference");
		expect(lines.join("\n")).not.toContain("sk-test");
	});

	it("injects cloud-managed AI provider keys into the child process without printing them", async () => {
		const catalogDir = join(fakeClawdiHome, "ai-providers");
		mkdirSync(catalogDir, { recursive: true });
		writeFileSync(
			join(catalogDir, "catalog.json"),
			JSON.stringify({
				schema_version: 1,
				providers: [
					{
						id: "custom-openai",
						type: "custom_openai_compatible",
						label: "Custom OpenAI",
						base_url: "https://provider.test/v1",
						default_model: "gpt-5.5",
						api_mode: "openai_responses",
						auth: { type: "api_key", source: "managed" },
						managed_by: "user",
						runtime_env_name: "CLAWDI_OPENAI_API_KEY",
					},
				],
				defaults: { chat_provider_id: "custom-openai" },
			}),
		);
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/ai-providers/custom-openai/auth/resolve",
				response: () => jsonResponse({ value: "sk-managed-provider" }),
			},
		]);
		const origLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await run(["codex", "exec"], { projectFolder: false }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].path).toBe("/v1/ai-providers/custom-openai/auth/resolve");
		expect(calls).toHaveLength(1);
		expect(calls[0].env.CLAWDI_OPENAI_API_KEY).toBe("sk-managed-provider");
		const out = lines.join("\n");
		expect(out).toContain("Resolved 1 AI provider key");
		expect(out).not.toContain("sk-managed-provider");
	});

	it("dry-runs env-file references without launching or fetching plaintext", async () => {
		const envFile = join(tmpRoot, ".env");
		writeFileSync(envFile, "OPENAI_API_KEY=clawdi://prod/openai/api_key\n");
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/resolve/bulk",
				response: () =>
					jsonResponse({
						results: {
							"clawdi://prod/openai/api_key": {
								reference: "clawdi://prod/openai/api_key",
								value: "sk-test",
								source_project_id: "project-default",
								source_alias: "prod",
								vault_slug: "prod",
								section: "openai",
								item_name: "api_key",
							},
						},
					}),
			},
		]);
		const origLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await run(
				["node", "server.js"],
				{
					envFile: [envFile],
					inheritEnv: false,
					projectFolder: false,
					dryRun: true,
				},
				spawnImpl,
			);
		} finally {
			console.log = origLog;
			restore();
		}

		const out = lines.join("\n");
		expect(calls).toHaveLength(0);
		expect(captured).toHaveLength(1);
		expect(captured[0].body).toMatchObject({ preview: true });
		expect(out).toContain("Dry run: command will not be launched.");
		expect(out).toContain("OPENAI_API_KEY");
		expect(out).toContain("redacted");
		expect(out).not.toContain("sk-test");
	});

	it("lets explicit env-file references override legacy all-vault values", async () => {
		const envFile = join(tmpRoot, ".env");
		writeFileSync(envFile, "OPENAI_API_KEY=clawdi://prod/openai/api_key\n");
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/resolve/bulk",
				response: () =>
					jsonResponse({
						results: {
							"clawdi://prod/openai/api_key": {
								reference: "clawdi://prod/openai/api_key",
								value: "sk-explicit",
								source_project_id: "project-default",
								source_alias: "project-default",
								vault_slug: "prod",
								section: "openai",
								item_name: "api_key",
							},
						},
					}),
			},
			{
				method: "POST",
				path: "/v1/vault/resolve",
				response: () => jsonResponse({ OPENAI_API_KEY: "sk-broad" }),
			},
		]);
		const origLog = console.log;
		console.log = () => {};

		try {
			await run(
				["node", "server.js"],
				{ envFile: [envFile], projectFolder: false, allVaultEnv: true },
				spawnImpl,
			);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(2);
		expect(calls).toHaveLength(1);
		expect(calls[0].env.OPENAI_API_KEY).toBe("sk-explicit");
	});

	it("uses linked Project folder when resolving env-file references", async () => {
		linkCurrentProjectFolder();
		const envFile = join(tmpRoot, ".env");
		writeFileSync(envFile, "OPENAI_API_KEY=clawdi://prod/openai/api_key\n");
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/resolve/bulk",
				response: () =>
					jsonResponse({
						results: {
							"clawdi://prod/openai/api_key": {
								reference: "clawdi://prod/openai/api_key",
								value: "sk-linked",
								source_project_id: "project-linked",
								source_alias: "engineering",
							},
						},
					}),
			},
		]);
		const origLog = console.log;
		console.log = () => {};

		try {
			await run(["node", "server.js"], { envFile: [envFile] }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].body).toMatchObject({ project_id: "project-linked" });
		expect(calls[0].env.OPENAI_API_KEY).toBe("sk-linked");
	});

	it("uses the project encoded in an exact reference instead of the folder link", async () => {
		linkCurrentProjectFolder();
		const envFile = join(tmpRoot, ".env");
		const exact =
			"clawdi://project/00000000-0000-0000-0000-000000000123/vault/default/field/OPENAI_API_KEY";
		writeFileSync(envFile, `OPENAI_API_KEY=${exact}\n`);
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/resolve/bulk",
				response: () =>
					jsonResponse({
						results: {
							[exact]: {
								reference: exact,
								value: "sk-exact",
								source_project_id: "00000000-0000-0000-0000-000000000123",
								source_alias: "production",
							},
						},
					}),
			},
		]);
		const origLog = console.log;
		console.log = () => {};

		try {
			await run(["node", "server.js"], { envFile: [envFile] }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].body).toMatchObject({
			references: [{ project_id: "00000000-0000-0000-0000-000000000123" }],
		});
		expect((captured[0].body as { project_id?: unknown }).project_id).toBeUndefined();
		expect(calls[0].env.OPENAI_API_KEY).toBe("sk-exact");
	});

	it("keeps exact references inside the requested agent boundary", async () => {
		const envFile = join(tmpRoot, ".env");
		const exact =
			"clawdi://project/00000000-0000-0000-0000-000000000123/vault/default/field/OPENAI_API_KEY";
		writeFileSync(envFile, `OPENAI_API_KEY=${exact}\n`);
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/resolve/bulk",
				response: () =>
					jsonResponse({
						results: {
							[exact]: {
								reference: exact,
								value: "sk-agent-exact",
								source_project_id: "00000000-0000-0000-0000-000000000123",
								source_alias: "attached-prod",
							},
						},
					}),
			},
		]);
		const origLog = console.log;
		console.log = () => {};

		try {
			await run(["node", "server.js"], { envFile: [envFile], agent: "agent-123" }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].body).toMatchObject({
			agent_id: "agent-123",
			references: [{ project_id: "00000000-0000-0000-0000-000000000123" }],
		});
		expect(calls[0].env.OPENAI_API_KEY).toBe("sk-agent-exact");
	});
});
