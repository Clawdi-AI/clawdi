import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const binPath = join(cliRoot, "bin", "clawdi.mjs");
const srcEntry = join(cliRoot, "src", "index.ts");

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
		CLAWDI_RUNTIME_AUTH_ENV: "CLAWDI_AUTH_TOKEN",
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
			expect(parsed.updateMode).toBe("local-self-update");
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
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

	it("runtime init enters repair and writes boot status without datasource", async () => {
		const { tmpdir } = await import("node:os");
		const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
		const root = join(tmpdir(), `clawdi-smoke-runtime-init-${Date.now()}`);
		const home = join(root, "home", "clawdi");
		const policyPath = join(root, "etc", "clawdi", "host-policy.json");
		const serviceStateRoot = join(root, "var", "lib", "clawdi");
		const runRoot = join(root, "run", "clawdi");
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

		const env = {
			HOME: home,
			CLAWDI_RUNTIME_MODE: "hosted",
			CLAWDI_HOST_POLICY_PATH: policyPath,
			CLAWDI_SERVICE_STATE_DIR: serviceStateRoot,
			CLAWDI_RUN_DIR: runRoot,
			CLAWDI_AUTH_TOKEN: undefined,
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
			expect(parsed.errors).toContain(
				`missing ${join(runRoot, "secrets", "auth-token")} and no last-good runtime manifest cache`,
			);
			expect(parsed.datasource).toBe("RuntimeSource");
			expect(parsed.hostPolicy.valid).toBe(true);
			expect(parsed.paths.serviceStateRoot).toBe(serviceStateRoot);
			expect(existsSync(join(serviceStateRoot, "cache", "boot-status.json"))).toBe(true);
			const cloudResult = JSON.parse(
				readFileSync(join(serviceStateRoot, "boot", "result.json"), "utf-8"),
			);
			expect(cloudResult.v1.stage).toBe("detect");
			expect(cloudResult.v1.errors).toEqual(parsed.errors);

			const status = await runCli(["runtime", "status", "--json"], env);
			expect(status.code).toBe(0);
			const statusParsed = JSON.parse(status.stdout);
			expect(statusParsed.exists).toBe(true);
			expect(statusParsed.status.mode).toBe("repair");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runtime init rejects a generic manifest-file fixture in hosted mode", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
		const root = join(tmpdir(), `clawdi-smoke-runtime-generic-reject-${Date.now()}`);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "generic-manifest.json");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_generic_reject",
				environmentId: "env_generic_reject",
				instanceId: "iid_generic_reject",
				generation: 1,
				issuedAt: "2026-07-12T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: { openclaw: { enabled: false } },
				recovery: {},
			}),
		);

		try {
			const result = await runCli(
				["runtime", "init", "--non-interactive", "--json", "--manifest-file", manifestPath],
				{
					HOME: home,
					CLAWDI_RUNTIME_MODE: "hosted",
					CLAWDI_SERVICE_STATE_DIR: state,
					CLAWDI_RUN_DIR: run,
				},
			);
			expect(result.code).toBe(22);
			expect(JSON.parse(result.stdout).mode).toBe("manifest-rejected");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runtime init converges a strict hosted manifest-file fixture", async () => {
		const { tmpdir } = await import("node:os");
		const { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = await import(
			"node:fs"
		);
		const root = join(tmpdir(), `clawdi-smoke-runtime-strict-${Date.now()}`);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "strict-hosted-manifest.json");
		const installer = join(root, "install-openclaw.sh");
		const managedCli = join(state, "bin", "clawdi");
		const managedCliTarget = join(state, "npm", "bin", "clawdi");
		mkdirSync(home, { recursive: true });
		mkdirSync(dirname(installer), { recursive: true });
		mkdirSync(dirname(managedCli), { recursive: true });
		mkdirSync(dirname(managedCliTarget), { recursive: true });
		mkdirSync(join(state, "status"), { recursive: true });
		writeFileSync(
			installer,
			`#!/usr/bin/env sh
set -eu
mkdir -p "$HOME/.openclaw/bin"
printf '#!/usr/bin/env sh\nexit 0\n' > "$HOME/.openclaw/bin/openclaw"
chmod +x "$HOME/.openclaw/bin/openclaw"
`,
		);
		chmodSync(installer, 0o700);
		writeFileSync(managedCliTarget, "#!/usr/bin/env sh\nexit 0\n");
		chmodSync(managedCliTarget, 0o700);
		symlinkSync(managedCliTarget, managedCli);
		writeFileSync(
			join(state, "status", "cli-bootstrap.json"),
			JSON.stringify({
				schemaVersion: "clawdi.cliNpmBootstrapStatus.v1",
				status: "installed",
				source: "npm",
				packageSpec: "clawdi@0.12.10-beta.55",
				registry: "https://registry.npmjs.org",
				activePath: managedCli,
				activeTarget: managedCliTarget,
				version: "0.12.10-beta.55",
			}),
		);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v2",
					minimumCliVersion: "0.12.10-beta.55",
					runtime: "openclaw",
					deploymentId: "dep_strict_smoke",
					environmentId: "env_strict_smoke",
					instanceId: "iid_strict_smoke",
					generation: 1,
					manifestETag: '"manifest-generation-1"',
					applyReceiptId: "apply-receipt-00000001",
					bootNonce: "boot-nonce-000000000001",
					issuedAt: "2026-07-12T00:00:00Z",
					locale: { language: "en", timezone: "UTC" },
					system: {},
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: "clawdi@0.12.10-beta.55",
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: {
							enabled: true,
							install: { source: "official" },
							providerMode: "unmanaged",
							provider_ids: [],
						},
					},
					providers: {},
					terminalTooling: {
						codex: {
							enabled: true,
							provider_id: "codex-managed",
							primary_model: { provider_id: "codex-managed", model: "gpt-test" },
							provider: {
								kind: "openai-compatible",
								type: "openai",
								baseUrl: "https://provider.test/v1",
								apiMode: "openai_responses",
								managed_by: "clawdi",
								runtimeEnvName: "OPENAI_API_KEY",
								apiKeySecretRef: "tool.codex.apiKey",
							},
						},
					},
					liveSync: { enabled: false, agents: [] },
					recovery: { cacheManifest: true, allowOfflineBoot: true },
				},
				secretValues: { "tool.codex.apiKey": "sk-codex-tool" },
			}),
		);

		try {
			const result = await runCli(
				["runtime", "init", "--non-interactive", "--json", "--manifest-file", manifestPath],
				{
					HOME: home,
					CLAWDI_RUNTIME_MODE: "hosted",
					CLAWDI_SERVICE_STATE_DIR: state,
					CLAWDI_RUN_DIR: run,
					CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS: "1",
					CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER: installer,
					CLAWDI_CODEX_INSTALL_DISABLED: "1",
				},
			);
			expect(result.code).toBe(0);
			const parsed = JSON.parse(result.stdout);
			expect(parsed.status).toBe("ok");
			expect(parsed.stage).toBe("final");
			expect(parsed.enabledRuntimes).toEqual(["openclaw"]);
			expect(parsed.manifestSource.type).toBe("fixture-file");
			expect(existsSync(join(home, ".openclaw", "bin", "openclaw"))).toBe(true);
			expect(existsSync(join(state, "cache", "manifest.last-good.json"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runtime init uses built-in policy when image policy is missing", async () => {
		const { tmpdir } = await import("node:os");
		const { existsSync, mkdirSync, rmSync } = await import("node:fs");
		const root = join(tmpdir(), `clawdi-smoke-runtime-no-policy-${Date.now()}`);
		const home = join(root, "home", "clawdi");
		const policyPath = join(root, "etc", "clawdi", "missing-host-policy.json");
		const serviceStateRoot = join(root, "var", "lib", "clawdi");
		mkdirSync(home, { recursive: true });

		try {
			const { stdout, code } = await runCli(["runtime", "init", "--non-interactive", "--json"], {
				HOME: home,
				CLAWDI_RUNTIME_MODE: "hosted",
				CLAWDI_HOST_POLICY_PATH: policyPath,
				CLAWDI_SERVICE_STATE_DIR: serviceStateRoot,
				CLAWDI_RUN_DIR: join(root, "run", "clawdi"),
				CLAWDI_AUTH_TOKEN: "auth-test-token",
			});
			expect(code).toBe(21);
			const parsed = JSON.parse(stdout);
			expect(parsed.mode).toBe("repair");
			expect(parsed.stage).toBe("network");
			expect(parsed.hostPolicy.exists).toBe(true);
			expect(parsed.hostPolicy.valid).toBe(true);
			expect(parsed.hostPolicy.source).toBe("builtin");
			expect(parsed.hostPolicy.path).toBeUndefined();
			expect(parsed.errors[0]).toContain("missing CLAWDI_RUNTIME_MANIFEST_URL");
			expect(existsSync(join(serviceStateRoot, "cache", "boot-status.json"))).toBe(true);
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
