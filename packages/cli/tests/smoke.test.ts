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
			expect(parsed.hosted.workspaceRoot).toBe(join(fakeHome, "clawdi"));
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

	it("runtime init performs first-install convergence from a fixture manifest", async () => {
		const { tmpdir } = await import("node:os");
		const { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } =
			await import("node:fs");
		const root = join(tmpdir(), `clawdi-smoke-runtime-full-${Date.now()}`);
		const home = join(root, "home", "clawdi");
		const policyPath = join(root, "etc", "clawdi", "host-policy.json");
		const manifestPath = join(root, "runtime-manifest.json");
		const staleManifestPath = join(root, "runtime-manifest-stale.json");
		const serviceStateRoot = join(root, "var", "lib", "clawdi");
		const runRoot = join(root, "run", "clawdi");
		const openclawInstaller = join(root, "fixtures", "openclaw-install.sh");
		const hermesInstaller = join(root, "fixtures", "hermes-install.sh");
		mkdirSync(dirname(policyPath), { recursive: true });
		mkdirSync(dirname(openclawInstaller), { recursive: true });
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
		writeFileSync(
			openclawInstaller,
			`#!/usr/bin/env bash
set -euo pipefail
install -d "$HOME/.openclaw/bin" "$HOME/.openclaw/install-proof"
printf '%s\\n' "\${NPM_CONFIG_PREFIX:-}" > "$HOME/.openclaw/install-proof/npm-config-prefix"
printf '%s\\n' "\${NPM_CONFIG_CACHE:-}" > "$HOME/.openclaw/install-proof/npm-config-cache"
printf '%s\\n' "\${NODE_EXTRA_CA_CERTS:-}" > "$HOME/.openclaw/install-proof/node-extra-ca-certs"
printf '%s\\n' "\${NPM_CONFIG_CAFILE:-}" > "$HOME/.openclaw/install-proof/npm-config-cafile"
cat > "$HOME/.openclaw/bin/openclaw" <<'SH'
#!/usr/bin/env bash
echo "openclaw fixture"
SH
chmod +x "$HOME/.openclaw/bin/openclaw"
`,
		);
		chmodSync(openclawInstaller, 0o700);
		writeFileSync(
			hermesInstaller,
			`#!/usr/bin/env bash
set -euo pipefail
install -d "$HOME/.local/bin" "$HOME/.hermes/hermes-agent" "$HOME/.hermes/install-proof"
printf '%s\\n' "\${NPM_CONFIG_PREFIX:-}" > "$HOME/.hermes/install-proof/npm-config-prefix"
printf '%s\\n' "\${NPM_CONFIG_CACHE:-}" > "$HOME/.hermes/install-proof/npm-config-cache"
printf '%s\\n' "\${NODE_EXTRA_CA_CERTS:-}" > "$HOME/.hermes/install-proof/node-extra-ca-certs"
printf '%s\\n' "\${NPM_CONFIG_CAFILE:-}" > "$HOME/.hermes/install-proof/npm-config-cafile"
printf '%s\\n' "\${HERMES_HOME:-}" > "$HOME/.hermes/install-proof/hermes-home"
printf '%s\\n' "\${UV_PYTHON_INSTALL_DIR:-}" > "$HOME/.hermes/install-proof/uv-python-install-dir"
printf '%s\\n' "\${UV_PYTHON_BIN_DIR:-}" > "$HOME/.hermes/install-proof/uv-python-bin-dir"
printf '%s\\n' "\${UV_MANAGED_PYTHON:-}" > "$HOME/.hermes/install-proof/uv-managed-python"
printf '%s\\n' "\${UV_NO_MANAGED_PYTHON:-}" > "$HOME/.hermes/install-proof/uv-no-managed-python"
printf '%s\\n' "\${UV_PYTHON_DOWNLOADS:-}" > "$HOME/.hermes/install-proof/uv-python-downloads"
cat > "$HOME/.local/bin/hermes" <<'SH'
#!/usr/bin/env bash
echo "hermes fixture"
SH
chmod +x "$HOME/.local/bin/hermes"
`,
		);
		chmodSync(hermesInstaller, 0o700);
		const mitmproxy = {
			type: "mitmproxy" as const,
			version: "12.2.3",
			url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
			sha256: "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
		};
		const mitmdump = join(
			serviceStateRoot,
			"maintained",
			"mitmproxy",
			mitmproxy.version,
			mitmproxy.sha256,
			"mitmdump",
		);
		mkdirSync(dirname(mitmdump), { recursive: true });
		writeFileSync(mitmdump, "#!/usr/bin/env sh\necho fake mitmdump\n");
		chmodSync(mitmdump, 0o755);

		const manifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_test",
			environmentId: "env_test",
			instanceId: "iid_test",
			generation: 7,
			issuedAt: "2026-06-03T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			clawdiCli: { version: "0.10.1", channel: "stable", source: "npm:clawdi@stable" },
			egressEngine: mitmproxy,
			runtimes: {
				openclaw: {
					enabled: true,
					updateChannel: "stable",
					install: {
						authority: "official",
						method: "official-installer",
						url: "https://openclaw.ai/install-cli.sh",
						home,
						args: ["--json", "--version", "stable", "--no-onboard"],
					},
				},
				hermes: {
					enabled: true,
					updateChannel: "main",
					install: {
						authority: "official",
						method: "official-installer",
						url: "https://hermes-agent.nousresearch.com/install.sh",
						home,
						args: ["--branch", "main", "--skip-setup", "--non-interactive"],
					},
					run: {
						env: {
							DISCORD_API_BASE_URL: "http://127.0.0.1:4500/discord",
						},
						args: ["gateway", "run"],
					},
				},
			},
			egressProfiles: {
				profiles: [
					{
						id: "codex-openai-responses",
						kind: "provider",
						match: {
							scheme: "https",
							host: "api.openai.com",
							pathPrefix: "/v1/",
							headers: {
								authorization: {
									type: "equals",
									value: "clawdi-egress-placeholder",
									prefix: "Bearer ",
								},
							},
						},
						rewrite: {
							upstreamBaseUrl: "http://127.0.0.1:18890/provider/openai/responses",
							preservePath: false,
							setHeaders: {
								authorization: "Bearer smoke-provider-key",
							},
						},
						logging: { redactHeaders: ["authorization"] },
						owner: "provider-projection",
					},
				],
			},
			projection: {
				aiProviders: {
					default: "openai-main/gpt-5.2",
				},
				mcp: { command: "clawdi mcp" },
			},
			liveSync: {
				enabled: true,
				agents: [{ agentType: "codex", environmentId: "env-codex" }],
			},
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		};
		writeFileSync(manifestPath, JSON.stringify(manifest));

		const env = {
			HOME: home,
			CLAWDI_RUNTIME_MODE: "hosted",
			CLAWDI_HOST_POLICY_PATH: policyPath,
			CLAWDI_SERVICE_STATE_DIR: serviceStateRoot,
			CLAWDI_RUN_DIR: runRoot,
			CLAWDI_AUTH_TOKEN: undefined,
			CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS: "1",
			CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER: openclawInstaller,
			CLAWDI_RUNTIME_TEST_HERMES_INSTALLER: hermesInstaller,
			CLAWDI_RUNTIME_MANIFEST_PATH: undefined,
			NPM_CONFIG_PREFIX: "/var/lib/clawdi/npm",
			NPM_CONFIG_CACHE: "/var/lib/clawdi/npm-cache",
			HERMES_HOME: undefined,
			OPENCLAW_STATE_DIR: undefined,
		};

		try {
			const first = await runCli(
				["runtime", "init", "--non-interactive", "--json", "--manifest-file", manifestPath],
				env,
			);
			expect(first.code).toBe(0);
			const parsed = JSON.parse(first.stdout);
			expect(parsed.mode).toBe("normal");
			expect(parsed.status).toBe("ok");
			expect(parsed.stage).toBe("final");
			expect(parsed.activeGeneration).toBe(7);
			expect(parsed.enabledRuntimes).toEqual(["hermes", "openclaw"]);
			expect(parsed.manifestSource.type).toBe("fixture-file");
			expect(parsed.paths.workspaceRoot).toBe(join(home, "clawdi"));
			expect(parsed.convergence.egressProfileBundle).toBe(
				join(serviceStateRoot, "config", "egress", "profiles.json"),
			);
			expect(parsed.convergence.daemonAuthTokenFile).toBeNull();
			expect(parsed.convergence.systemdSystemUnits).toEqual([
				join(runRoot, "systemd", "system", "clawdi-runtime-sidecar.service"),
			]);

			for (const outputPath of [
				join(serviceStateRoot, "config", "clawdi.json"),
				join(serviceStateRoot, "sync", "runtimes.json"),
				join(serviceStateRoot, "cache", "manifest.last-good.json"),
				join(runRoot, "instance-data.json"),
				join(runRoot, "instance-data-sensitive.json"),
				join(serviceStateRoot, "install-inventory", "openclaw.json"),
				join(serviceStateRoot, "install-inventory", "hermes.json"),
				join(serviceStateRoot, "config", "projections", "openclaw.json"),
				join(serviceStateRoot, "config", "projections", "hermes.json"),
				join(serviceStateRoot, "config", "run", "openclaw.json"),
				join(serviceStateRoot, "config", "run", "hermes.json"),
				join(
					home,
					".config",
					"systemd",
					"user",
					"openclaw-gateway.service.d",
					"10-clawdi-hosted.conf",
				),
				join(
					home,
					".config",
					"systemd",
					"user",
					"hermes-gateway.service.d",
					"10-clawdi-hosted.conf",
				),
				join(runRoot, "systemd", "env", "openclaw-gateway.service.env"),
				join(runRoot, "systemd", "env", "hermes-gateway.service.env"),
				join(runRoot, "systemd", "env", "clawdi-runtime-sidecar.service.env"),
				join(runRoot, "systemd", "system", "clawdi-runtime-sidecar.service"),
				join(runRoot, "egress", "transparent-egress.env"),
				join(runRoot, "egress", "clawdi_egress_addon.py"),
				join(serviceStateRoot, "config", "egress", "profiles.json"),
				join(serviceStateRoot, "instances", "iid_test", "boot-finished"),
				join(home, "clawdi"),
				join(home, ".openclaw", "bin", "openclaw"),
				join(home, ".local", "bin", "hermes"),
			]) {
				if (!existsSync(outputPath)) {
					throw new Error(`expected runtime init output to exist: ${outputPath}`);
				}
			}
			for (const staleShimPath of [
				join(serviceStateRoot, "bin", ".clawdi-runtime-command-shim"),
				join(serviceStateRoot, "bin", "openclaw"),
				join(serviceStateRoot, "bin", "hermes"),
				join(serviceStateRoot, "bin", "codex"),
				join(serviceStateRoot, "config", "runtime-command-shims.json"),
				join(serviceStateRoot, "supervisor", "supervisord.conf"),
				join(runRoot, "supervisor", "supervisord.conf"),
				join(runRoot, "launch", "openclaw.sh"),
				join(runRoot, "launch", "openclaw.env"),
				join(runRoot, "launch", "hermes.sh"),
				join(runRoot, "launch", "hermes.env"),
			]) {
				expect(existsSync(staleShimPath)).toBe(false);
			}
			expect(statSync(join(serviceStateRoot, "cache", "boot-status.json")).mode & 0o777).toBe(
				0o644,
			);
			expect(statSync(join(serviceStateRoot, "boot", "status.json")).mode & 0o777).toBe(0o644);
			expect(statSync(join(serviceStateRoot, "boot", "result.json")).mode & 0o777).toBe(0o644);
			expect(statSync(join(runRoot, "instance-data-sensitive.json")).mode & 0o777).toBe(0o600);
			expect(
				JSON.parse(readFileSync(join(runRoot, "instance-data-sensitive.json"), "utf-8"))
					.tokenSource,
			).toBe("fixture-file");
			expect(
				readFileSync(join(home, ".openclaw", "install-proof", "npm-config-prefix"), "utf-8"),
			).toBe("\n");
			expect(
				readFileSync(join(home, ".openclaw", "install-proof", "npm-config-cache"), "utf-8"),
			).toBe("\n");
			expect(
				readFileSync(join(home, ".openclaw", "install-proof", "node-extra-ca-certs"), "utf-8"),
			).toBe("/etc/ssl/certs/ca-certificates.crt\n");
			expect(
				readFileSync(join(home, ".openclaw", "install-proof", "npm-config-cafile"), "utf-8"),
			).toBe("/etc/ssl/certs/ca-certificates.crt\n");
			expect(
				readFileSync(join(home, ".hermes", "install-proof", "npm-config-prefix"), "utf-8"),
			).toBe("\n");
			expect(
				readFileSync(join(home, ".hermes", "install-proof", "npm-config-cache"), "utf-8"),
			).toBe("\n");
			expect(
				readFileSync(join(home, ".hermes", "install-proof", "node-extra-ca-certs"), "utf-8"),
			).toBe("/etc/ssl/certs/ca-certificates.crt\n");
			expect(
				readFileSync(join(home, ".hermes", "install-proof", "npm-config-cafile"), "utf-8"),
			).toBe("/etc/ssl/certs/ca-certificates.crt\n");
			expect(readFileSync(join(home, ".hermes", "install-proof", "hermes-home"), "utf-8")).toBe(
				`${join(home, ".hermes")}\n`,
			);
			expect(
				readFileSync(join(home, ".hermes", "install-proof", "uv-python-install-dir"), "utf-8"),
			).toBe(`${join(home, ".hermes", "uv", "python")}\n`);
			expect(
				readFileSync(join(home, ".hermes", "install-proof", "uv-python-bin-dir"), "utf-8"),
			).toBe(`${join(home, ".hermes", "uv", "bin")}\n`);
			expect(
				readFileSync(join(home, ".hermes", "install-proof", "uv-managed-python"), "utf-8"),
			).toBe("1\n");
			expect(
				readFileSync(join(home, ".hermes", "install-proof", "uv-no-managed-python"), "utf-8"),
			).toBe("\n");
			expect(
				readFileSync(join(home, ".hermes", "install-proof", "uv-python-downloads"), "utf-8"),
			).toBe("\n");

			const managed = JSON.parse(
				readFileSync(join(serviceStateRoot, "config", "clawdi.json"), "utf-8"),
			);
			expect(managed.generation).toBe(7);
			expect(JSON.stringify(managed)).not.toContain("auth-test-token");
			const hermesUnit = readFileSync(
				join(
					home,
					".config",
					"systemd",
					"user",
					"hermes-gateway.service.d",
					"10-clawdi-hosted.conf",
				),
				"utf-8",
			);
			const openclawUnit = readFileSync(
				join(
					home,
					".config",
					"systemd",
					"user",
					"openclaw-gateway.service.d",
					"10-clawdi-hosted.conf",
				),
				"utf-8",
			);
			const sidecarUnit = readFileSync(
				join(runRoot, "systemd", "system", "clawdi-runtime-sidecar.service"),
				"utf-8",
			);
			const openclawEnv = readFileSync(
				join(runRoot, "systemd", "env", "openclaw-gateway.service.env"),
				"utf-8",
			);
			expect(hermesUnit).toContain(
				`ExecStart="${join(home, ".local", "bin", "hermes")}" "gateway" "run"`,
			);
			expect(openclawUnit).toContain(
				`ExecStart="${join(home, ".openclaw", "bin", "openclaw")}" "gateway" "run"`,
			);
			expect(sidecarUnit).toContain('ExecStart="clawdi" "runtime" "sidecar"');
			expect(existsSync(join(runRoot, "systemd", "system", "clawdi-runtime-sidecar.service"))).toBe(
				true,
			);
			expect(hermesUnit).not.toContain("clawdi run -- hermes");
			expect(openclawUnit).not.toContain("clawdi run -- openclaw");
			expect(openclawEnv).toContain('CLAWDI_RUNTIME_REV="');
			expect(openclawEnv).toContain('OPENCLAW_SYSTEMD_UNIT="openclaw-gateway.service"');
			expect(openclawUnit).not.toContain("auth-test-token");
			expect(openclawEnv).not.toContain("auth-test-token");
			const inventory = JSON.parse(
				readFileSync(join(serviceStateRoot, "install-inventory", "openclaw.json"), "utf-8"),
			);
			expect(inventory.install.url).toBe("https://openclaw.ai/install-cli.sh");
			expect(inventory.install.args).not.toContain("--dir");
			expect(inventory.install.args).not.toContain("--prefix");
			expect(inventory.status).toBe("installed");
			expect(inventory.commandPath).toBe(join(home, ".openclaw", "bin", "openclaw"));
			expect(typeof inventory.installStartedAt).toBe("string");
			expect(typeof inventory.installFinishedAt).toBe("string");
			expect(typeof inventory.installDurationMs).toBe("number");
			expect(inventory.installDurationMs).toBeGreaterThanOrEqual(0);
			const openclawRunConfig = JSON.parse(
				readFileSync(join(serviceStateRoot, "config", "run", "openclaw.json"), "utf-8"),
			);
			expect(openclawRunConfig.schemaVersion).toBe("clawdi.runtimeRunConfig.v1");
			expect(openclawRunConfig.commandPath).toBe(join(home, ".openclaw", "bin", "openclaw"));
			expect(openclawRunConfig.defaultArgs).toEqual([
				"gateway",
				"run",
				"--allow-unconfigured",
				"--bind",
				"loopback",
				"--force",
			]);
			expect(openclawRunConfig.env.CLAWDI_EGRESS_SECRET_FILE).toBeUndefined();
			const hermesRunConfig = JSON.parse(
				readFileSync(join(serviceStateRoot, "config", "run", "hermes.json"), "utf-8"),
			);
			expect(hermesRunConfig.schemaVersion).toBe("clawdi.runtimeRunConfig.v1");
			expect(hermesRunConfig.commandPath).toBe(join(home, ".local", "bin", "hermes"));
			expect(hermesRunConfig.defaultArgs).toEqual(["gateway", "run"]);
			expect(hermesRunConfig.env.DISCORD_API_BASE_URL).toBe("http://127.0.0.1:4500/discord");
			expect(hermesRunConfig.env.CLAWDI_EGRESS_SECRET_FILE).toBeUndefined();
			expect(hermesRunConfig.egressProfileBundlePath).toBe(
				join(serviceStateRoot, "config", "egress", "profiles.json"),
			);
			const egressProfiles = JSON.parse(
				readFileSync(join(serviceStateRoot, "config", "egress", "profiles.json"), "utf-8"),
			);
			expect(egressProfiles.schemaVersion).toBe("clawdi.egressProfiles.v1");
			expect(egressProfiles.profiles[0].id).toBe("codex-openai-responses");
			expect(JSON.stringify(egressProfiles)).toContain("smoke-provider-key");
			expect(JSON.stringify(egressProfiles)).not.toContain("auth-test-token");

			const offline = await runCli(["runtime", "init", "--non-interactive", "--json"], env);
			expect(offline.code).toBe(0);
			const offlineParsed = JSON.parse(offline.stdout);
			expect(offlineParsed.mode).toBe("degraded-offline");
			expect(offlineParsed.status).toBe("ok");

			writeFileSync(staleManifestPath, JSON.stringify({ ...manifest, generation: 6 }));
			const stale = await runCli(
				["runtime", "init", "--non-interactive", "--json", "--manifest-file", staleManifestPath],
				env,
			);
			expect(stale.code).toBe(0);
			const staleParsed = JSON.parse(stale.stdout);
			expect(staleParsed.mode).toBe("normal");
			expect(staleParsed.activeGeneration).toBe(6);
			const lastGood = JSON.parse(
				readFileSync(join(serviceStateRoot, "cache", "manifest.last-good.json"), "utf-8"),
			);
			expect(lastGood.generation).toBe(6);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runtime init rejects fixture secretRefs without inline secretValues", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync } = await import("node:fs");
		const root = join(tmpdir(), `clawdi-smoke-runtime-secretref-${Date.now()}`);
		const home = join(root, "home", "clawdi");
		const policyPath = join(root, "etc", "clawdi", "host-policy.json");
		const manifestPath = join(root, "runtime-manifest.json");
		const serviceStateRoot = join(root, "var", "lib", "clawdi");
		const runRoot = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		mkdirSync(dirname(policyPath), { recursive: true });
		writeFileSync(
			policyPath,
			JSON.stringify({
				schemaVersion: "clawdi.hostPolicy.v1",
				mode: "hosted-runtime",
				cliUpdateMode: "system-managed-npm",
				deniedCommands: ["setup", "teardown", "update"],
			}),
		);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_secretref_reject",
				environmentId: "env_secretref_reject",
				instanceId: "iid_secretref_reject",
				generation: 1,
				issuedAt: "2026-06-04T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.example.test" },
				runtimes: {
					openclaw: { enabled: false },
					hermes: { enabled: false },
				},
				egressProfiles: {
					profiles: [
						{
							id: "codex-openai-responses",
							kind: "provider",
							match: {
								scheme: "https",
								host: "api.openai.com",
								pathPrefix: "/v1/",
								headers: {
									authorization: {
										type: "equals",
										value: "clawdi-egress-placeholder",
										prefix: "Bearer ",
									},
								},
							},
							rewrite: {
								upstreamBaseUrl: "https://sub2api.test/v1/responses",
								preservePath: false,
								setHeaders: {
									authorization: {
										type: "secretRef",
										secretRef: "secret://provider.default.apiKey",
										prefix: "Bearer ",
									},
								},
							},
						},
					],
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);

		try {
			const result = await runCli(
				["runtime", "init", "--non-interactive", "--json", "--manifest-file", manifestPath],
				{
					HOME: home,
					CLAWDI_RUNTIME_MODE: "hosted",
					CLAWDI_HOST_POLICY_PATH: policyPath,
					CLAWDI_SERVICE_STATE_DIR: serviceStateRoot,
					CLAWDI_RUN_DIR: runRoot,
					CLAWDI_RUNTIME_MANIFEST_PATH: undefined,
				},
			);
			expect(result.code).toBe(22);
			const parsed = JSON.parse(result.stdout);
			expect(parsed.mode).toBe("manifest-rejected");
			expect(parsed.errors[0]).toContain("fixture references secretValues");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runtime init installs only selected runtimes", async () => {
		const { tmpdir } = await import("node:os");
		const { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import(
			"node:fs"
		);
		const root = join(tmpdir(), `clawdi-smoke-runtime-selection-${Date.now()}`);
		const home = join(root, "home", "clawdi");
		const policyPath = join(root, "etc", "clawdi", "host-policy.json");
		const manifestPath = join(root, "runtime-manifest.json");
		const serviceStateRoot = join(root, "var", "lib", "clawdi");
		const runRoot = join(root, "run", "clawdi");
		const openclawInstaller = join(root, "fixtures", "openclaw-install.sh");
		mkdirSync(dirname(policyPath), { recursive: true });
		mkdirSync(dirname(openclawInstaller), { recursive: true });
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
		writeFileSync(
			openclawInstaller,
			`#!/usr/bin/env bash
set -euo pipefail
install -d "$HOME/.openclaw/bin"
cat > "$HOME/.openclaw/bin/openclaw" <<'SH'
#!/usr/bin/env bash
echo "openclaw fixture"
SH
chmod +x "$HOME/.openclaw/bin/openclaw"
`,
		);
		chmodSync(openclawInstaller, 0o700);

		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_selection",
				environmentId: "env_selection",
				instanceId: "iid_selection",
				generation: 1,
				issuedAt: "2026-06-04T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.example.test" },
				runtimes: {
					openclaw: {
						enabled: true,
						updateChannel: "stable",
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: ["--json", "--no-onboard"],
						},
					},
					hermes: {
						enabled: false,
					},
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			}),
		);

		try {
			const result = await runCli(
				["runtime", "init", "--non-interactive", "--json", "--manifest-file", manifestPath],
				{
					HOME: home,
					CLAWDI_RUNTIME_MODE: "hosted",
					CLAWDI_HOST_POLICY_PATH: policyPath,
					CLAWDI_SERVICE_STATE_DIR: serviceStateRoot,
					CLAWDI_RUN_DIR: runRoot,
					CLAWDI_AUTH_TOKEN: "auth-selection-token",
					CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS: "1",
					CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER: openclawInstaller,
					CLAWDI_RUNTIME_TEST_HERMES_INSTALLER: undefined,
					CLAWDI_RUNTIME_MANIFEST_PATH: undefined,
					HERMES_HOME: undefined,
					OPENCLAW_STATE_DIR: undefined,
				},
			);
			expect(result.code).toBe(0);
			const parsed = JSON.parse(result.stdout);
			expect(parsed.enabledRuntimes).toEqual(["openclaw"]);
			expect(existsSync(join(home, ".openclaw", "bin", "openclaw"))).toBe(true);
			expect(existsSync(join(home, ".local", "bin", "hermes"))).toBe(false);
			expect(existsSync(join(serviceStateRoot, "bin", "openclaw"))).toBe(false);
			expect(existsSync(join(serviceStateRoot, "bin", "hermes"))).toBe(false);
			expect(existsSync(join(serviceStateRoot, "bin", "codex"))).toBe(false);
			expect(existsSync(join(serviceStateRoot, "bin", ".clawdi-runtime-command-shim"))).toBe(false);
			expect(existsSync(join(serviceStateRoot, "config", "runtime-command-shims.json"))).toBe(
				false,
			);
			expect(existsSync(join(runRoot, "launch", "openclaw.sh"))).toBe(false);
			expect(existsSync(join(runRoot, "launch", "openclaw.env"))).toBe(false);
			expect(existsSync(join(runRoot, "launch", "hermes.sh"))).toBe(false);
			expect(existsSync(join(runRoot, "launch", "hermes.env"))).toBe(false);

			const openclawInventory = JSON.parse(
				readFileSync(join(serviceStateRoot, "install-inventory", "openclaw.json"), "utf-8"),
			);
			const hermesInventory = JSON.parse(
				readFileSync(join(serviceStateRoot, "install-inventory", "hermes.json"), "utf-8"),
			);
			expect(openclawInventory.status).toBe("installed");
			expect(hermesInventory.status).toBe("disabled");
			const hermesRunConfig = JSON.parse(
				readFileSync(join(serviceStateRoot, "config", "run", "hermes.json"), "utf-8"),
			);
			expect(hermesRunConfig.enabled).toBe(false);
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
