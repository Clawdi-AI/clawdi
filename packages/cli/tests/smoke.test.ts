import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const binPath = join(cliRoot, "bin", "clawdi.mjs");
const srcEntry = join(cliRoot, "src", "index.ts");
function writeRuntimeContext(
	path: string,
	options: { authToken?: string | null; manifestUrl?: string } = {},
): void {
	const authToken = options.authToken === undefined ? "smoke-runtime-token" : options.authToken;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({
			schemaVersion: "clawdi.runtimeContext.v2",
			backend: "incus",
			apply: {
				generation: 1,
				manifestETag: '"smoke-manifest-1"',
				applyReceiptId: "smoke-apply-receipt-0001",
				bootNonce: "smoke-boot-nonce-000001",
			},
			cliPackageSpec: "clawdi@1.2.3-test",
			manifestSource: {
				type: "http",
				url: options.manifestUrl ?? "https://runtime.test/v1/runtime/manifest",
				...(authToken === null ? {} : { auth: { type: "bearer", token: authToken } }),
			},
		})}\n`,
	);
}

/**
 * Run the CLI and return stdout + stderr + exit code.
 * Uses the src entry (fast; no build step needed). The bin wrapper smoke
 * tests verify the dist path separately (run post-build).
 */
async function runCli(
	args: string[],
	envOverrides: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	const env: Record<string, string> = {
		...process.env,
		CLAWDI_NO_AUTO_UPDATE: "1",
		CLAWDI_NO_UPDATE_CHECK: "1",
	};
	for (const [key, value] of Object.entries(envOverrides)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	const proc = Bun.spawn(["bun", srcEntry, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

describe("CLI smoke — src entry", () => {
	it("--version prints a semver-ish string", async () => {
		const { stdout, code } = await runCli(["--version"]);
		expect(code).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("--help lists every top-level command", async () => {
		const { stdout, code } = await runCli(["--help"]);
		expect(code).toBe(0);
		for (const cmd of [
			"auth",
			"status",
			"config",
			"setup",
			"push",
			"pull",
			"ai-provider",
			"vault",
			"skill",
			"memory",
			"doctor",
			"capabilities",
			"update",
			"mcp",
			"read",
			"inject",
			"run",
			"runtime",
		]) {
			expect(stdout).toContain(cmd);
		}
	});

	it("capabilities prints JSON without requiring auth", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync } = await import("node:fs");
		const fakeHome = join(tmpdir(), `clawdi-smoke-cap-${Date.now()}`);
		mkdirSync(fakeHome, { recursive: true });

		try {
			const { stdout, code } = await runCli(["capabilities", "--json"], { HOME: fakeHome });
			expect(code).toBe(0);
			const parsed = JSON.parse(stdout);
			expect(parsed.schemaVersion).toBe("clawdi.capabilities.v1");
			expect(parsed.commands).toContain("runtime");
			expect(parsed.commands).toContain("deploy");
			expect(parsed.commands).toContain("channel");
			expect(parsed.updateMode).toBe("local-self-update");
			expect(parsed.providerApply).toBeUndefined();
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("ai-provider help omits retired local activation commands", async () => {
		const { stdout, code } = await runCli(["ai-provider", "--help"]);
		expect(code).toBe(0);
		expect(stdout).not.toContain("apply");
		expect(stdout).not.toContain("materialize-auth");
		expect(stdout).not.toContain("status");
	});

	it("auth status reports no auth in an isolated HOME", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync } = await import("node:fs");
		const fakeHome = join(tmpdir(), `clawdi-smoke-auth-${Date.now()}`);
		mkdirSync(fakeHome, { recursive: true });

		try {
			const { stdout, code } = await runCli(["auth", "status", "--json"], {
				HOME: fakeHome,
				CLAWDI_AUTH_TOKEN: undefined,
			});
			expect(code).toBe(0);
			const parsed = JSON.parse(stdout);
			expect(parsed.authenticated).toBe(false);
			expect(parsed.source).toBe("none");
			expect(stdout).not.toContain("secret");
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("config paths reports local ~/.clawdi paths", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync } = await import("node:fs");
		const fakeHome = join(tmpdir(), `clawdi-smoke-paths-${Date.now()}`);
		mkdirSync(fakeHome, { recursive: true });

		try {
			const { stdout, code } = await runCli(["config", "paths", "--json"], { HOME: fakeHome });
			expect(code).toBe(0);
			const parsed = JSON.parse(stdout);
			expect(parsed.runtimeMode).toBe("local");
			expect(parsed.local.config).toBe(join(fakeHome, ".clawdi", "config.json"));
			expect(parsed.hosted.serviceStateRoot).toBe("/var/lib/clawdi");
			expect(parsed.hosted.workspaceRoot).toBe(fakeHome);
			expect(stdout).not.toContain("CLAWDI_AUTH_TOKEN");
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("runtime status exits cleanly before runtime init", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync } = await import("node:fs");
		const fakeHome = join(tmpdir(), `clawdi-smoke-runtime-status-${Date.now()}`);
		mkdirSync(fakeHome, { recursive: true });

		try {
			const { stdout, code } = await runCli(["runtime", "status", "--json"], {
				HOME: fakeHome,
				CLAWDI_SERVICE_STATE_DIR: join(fakeHome, "var", "lib", "clawdi"),
				CLAWDI_RUN_DIR: join(fakeHome, "run", "clawdi"),
			});
			expect(code).toBe(0);
			const parsed = JSON.parse(stdout);
			expect(parsed.schemaVersion).toBe("clawdi.runtimeStatus.v1");
			expect(parsed.exists).toBe(false);
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("runtime verify treats a missing manifest cache as not checked", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync } = await import("node:fs");
		const root = join(tmpdir(), `clawdi-smoke-runtime-verify-${Date.now()}`);
		mkdirSync(join(root, "home"), { recursive: true });

		try {
			const { stdout, code } = await runCli(["runtime", "verify", "--json"], {
				HOME: join(root, "home"),
				CLAWDI_SERVICE_STATE_DIR: join(root, "state"),
				CLAWDI_RUN_DIR: join(root, "run"),
			});
			expect(code).toBe(0);
			const parsed = JSON.parse(stdout);
			expect(parsed.status).toBe("ok");
			expect(parsed.manifestCache).toMatchObject({ exists: false, valid: null });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runtime init fails closed when the canonical context is invalid", async () => {
		const { tmpdir } = await import("node:os");
		const { existsSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
		const root = join(tmpdir(), `clawdi-smoke-runtime-init-${Date.now()}`);
		const home = join(root, "home", "clawdi");
		const policyPath = join(root, "etc", "clawdi", "host-policy.json");
		const serviceStateRoot = join(root, "var", "lib", "clawdi");
		const runRoot = join(root, "run", "clawdi");
		const contextPath = join(root, "runtime-context.json");
		mkdirSync(dirname(policyPath), { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(
			policyPath,
			JSON.stringify({
				schemaVersion: "clawdi.hostPolicy.v1",
				mode: "hosted-runtime",
				cliUpdateMode: "system-managed-npm",
				deniedCommands: ["setup", "teardown", "update"],
			}),
		);

		writeRuntimeContext(contextPath, { authToken: null });
		const env = {
			HOME: "/home/clawdi",
			CLAWDI_RUNTIME_MODE: "hosted",
			CLAWDI_RUNTIME_USER: "clawdi",
			CLAWDI_RUNTIME_UID: "10001",
			CLAWDI_RUNTIME_GID: "10001",
			CLAWDI_HOST_POLICY_PATH: policyPath,
			CLAWDI_SERVICE_STATE_DIR: serviceStateRoot,
			CLAWDI_RUN_DIR: runRoot,
			CLAWDI_AUTH_TOKEN: undefined,
			CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS: "1",
			CLAWDI_RUNTIME_TEST_CONTEXT_FILE: contextPath,
		};

		try {
			const { stdout, code } = await runCli(
				["runtime", "init", "--non-interactive", "--json"],
				env,
			);
			expect(code).toBe(20);
			const parsed = JSON.parse(stdout);
			expect(parsed.mode).toBe("repair");
			expect(parsed.status).toBe("error");
			expect(parsed.stage).toBe("detect");
			expect(parsed.errors[0]).toContain(`invalid runtime context file ${contextPath}`);
			expect(parsed.errors[0]).toContain("manifestSource.auth: Invalid input");
			expect(parsed.datasource).toBe("RuntimeSource");
			expect(parsed.hostPolicy).toMatchObject({
				source: "builtin",
				exists: true,
				valid: true,
				mode: "hosted",
			});
			expect(parsed.paths.serviceStateRoot).toBe(serviceStateRoot);
			expect(existsSync(serviceStateRoot)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runtime init rejects a wrong hosted HOME before creating state", async () => {
		const { tmpdir } = await import("node:os");
		const { existsSync, mkdirSync, rmSync } = await import("node:fs");
		const root = join(tmpdir(), `clawdi-smoke-runtime-no-policy-${Date.now()}`);
		const home = join(root, "home", "clawdi");
		const policyPath = join(root, "etc", "clawdi", "missing-host-policy.json");
		const serviceStateRoot = join(root, "var", "lib", "clawdi");
		const runRoot = join(root, "run", "clawdi");
		const contextPath = join(root, "runtime-context.json");
		mkdirSync(home, { recursive: true });

		try {
			writeRuntimeContext(contextPath);
			const { stdout, code } = await runCli(["runtime", "init", "--non-interactive", "--json"], {
				HOME: home,
				CLAWDI_RUNTIME_MODE: "hosted",
				CLAWDI_HOST_POLICY_PATH: policyPath,
				CLAWDI_SERVICE_STATE_DIR: serviceStateRoot,
				CLAWDI_RUN_DIR: runRoot,
				CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS: "1",
				CLAWDI_RUNTIME_TEST_CONTEXT_FILE: contextPath,
			});
			expect(code).toBe(20);
			const parsed = JSON.parse(stdout);
			expect(parsed.mode).toBe("repair");
			expect(parsed.stage).toBe("detect");
			expect(parsed.errors[0]).toContain("hosted runtime HOME must resolve to /home/clawdi");
			expect(existsSync(serviceStateRoot)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("built-in hosted policy denies CLI self-update", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync } = await import("node:fs");
		const root = join(tmpdir(), `clawdi-smoke-policy-${Date.now()}`);
		const home = join(root, "home", "clawdi");
		mkdirSync(home, { recursive: true });

		try {
			const result = await runCli(["update"], {
				HOME: home,
				CLAWDI_RUNTIME_MODE: "hosted",
				CLAWDI_SERVICE_STATE_DIR: join(root, "var", "lib", "clawdi"),
				CLAWDI_RUN_DIR: join(root, "run", "clawdi"),
			});
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("disabled in hosted runtime mode");
			expect(result.stderr).toContain("managed by the hosted runtime installation");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("status exits cleanly when not logged in (via isolated HOME)", async () => {
		// Point HOME at a throwaway dir so we don't read the user's real auth
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync } = await import("node:fs");
		const fakeHome = join(tmpdir(), `clawdi-smoke-${Date.now()}`);
		mkdirSync(fakeHome, { recursive: true });

		try {
			const proc = Bun.spawn(["bun", srcEntry, "status"], {
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, HOME: fakeHome, CLAWDI_API_URL: "http://127.0.0.1:0" },
			});
			const stdout = await new Response(proc.stdout).text();
			const code = await proc.exited;
			expect(code).toBe(0);
			// stdout is piped (non-TTY), so status auto-renders JSON.
			const parsed = JSON.parse(stdout);
			expect(parsed.loggedIn).toBe(false);
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("unknown command exits non-zero", async () => {
		const { code } = await runCli(["nonexistent-command-xyz"]);
		expect(code).not.toBe(0);
	});

	it("config list exits 0 on an empty config", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync } = await import("node:fs");
		const fakeHome = join(tmpdir(), `clawdi-smoke-cfg-${Date.now()}`);
		mkdirSync(fakeHome, { recursive: true });

		try {
			const proc = Bun.spawn(["bun", srcEntry, "config", "list"], {
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, HOME: fakeHome },
			});
			const code = await proc.exited;
			expect(code).toBe(0);
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});
});

describe("CLI smoke — bin wrapper", () => {
	it("bin/clawdi.mjs --version runs via the wrapper", async () => {
		// Only meaningful after `bun run build`; when dist/ is missing, skip gracefully.
		const { existsSync } = await import("node:fs");
		if (!existsSync(join(cliRoot, "dist", "index.js"))) return;

		const proc = Bun.spawn(["bun", binPath, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		expect(code).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("bin/clawdi.mjs inject --in - reads stdin under Node", async () => {
		const { existsSync, readFileSync } = await import("node:fs");
		const distEntry = join(cliRoot, "dist", "index.js");
		if (!existsSync(distEntry)) return;
		// Local worktrees may have a stale dist/ from an earlier build. The
		// post-build path below is still valuable when dist matches this source.
		if (readFileSync(distEntry, "utf8").includes("Bun.stdin")) return;

		const proc = Bun.spawn(["node", binPath, "inject", "--in", "-", "--out", "-"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				CLAWDI_NO_AUTO_UPDATE: "1",
				CLAWDI_NO_UPDATE_CHECK: "1",
				NO_COLOR: "1",
			},
		});
		proc.stdin.write("PLAIN=value\n");
		proc.stdin.end();

		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code).toBe(0);
		expect(stdout).toBe("PLAIN=value\n");
		expect(stderr).toContain("Resolved 0 clawdi references");
	});
});
