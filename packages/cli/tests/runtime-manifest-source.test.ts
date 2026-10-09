import { describe, expect, it, spyOn } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	commitRuntimeAppliedState,
	runtimeAppliedContentIdentity,
	runtimePublicContentRevision,
	runtimePublicSourcePath,
	runtimeWatchEventForOutcome,
} from "../src/commands/runtime";
import { readRuntimeAppliedState, writeRuntimeAppliedState } from "../src/runtime/applied-state";
import { runtimeManifestSourceSchema } from "../src/runtime/apply-identity";
import { reconcilePendingRuntimeCliUpgrade } from "../src/runtime/cli-update";
import { withRuntimeConvergeLock } from "../src/runtime/converge-lock";
import {
	deniedCommandReason,
	evaluateHostPolicyForCommand,
	readHostPolicy,
} from "../src/runtime/host-policy";
import { resolveHostedOpenClawWorkspace } from "../src/runtime/hosted-openclaw-context";
import { hostedAiProviderCatalog } from "../src/runtime/hosted-provider-resolution";
import type { RuntimeManifest } from "../src/runtime/manifest";
import { officialInstallArgs } from "../src/runtime/manifest-contract";
import { runtimeConvergenceWithoutApply } from "../src/runtime/manifest-planning";
import {
	loadCommittedRuntimeManifest,
	parseHostedRuntimeBundleV2,
	type RuntimeBundleChannelBinding,
	type RuntimeManifestLoad,
} from "../src/runtime/manifest-source";
import { readHostedRuntimeObserved } from "../src/runtime/observed";
import { detectRuntimeMode, getRuntimePaths } from "../src/runtime/paths";
import { buildRuntimeRunConfig } from "../src/runtime/run-config";
import { TRANSPARENT_EGRESS_PORT } from "../src/runtime/transparent-egress";
import { getDaemonControlTokenPath } from "../src/serve/paths";
import {
	applyRuntimeBundleChannelsToManifestLoad,
	CANONICAL_TEST_CONTEXT,
	convergeRuntimeManifest,
	createVersionedCliFixture,
	expectEgressProfileBundleUsesSecretRef,
	expectExistingFileNotToContain,
	expectMitmSecretFileIsSidecarOnly,
	expectProviderEgressProfileUsesSecretRef,
	expectRecord,
	HERMES_CONFIG_CLI_MOCK,
	type HostedRuntimeResponseFixture,
	hermesTestPythonScript,
	hostedCliManifestResponse,
	hostedHermesDashboardCapabilityLoad,
	hostedHermesRuntime,
	hostedHermesSystemFixture,
	hostedOpenClawRuntime,
	hostedRequiredState,
	hostedRuntimeBundleResponse,
	hostedRuntimeWatchLocalePayload,
	hostedSingleProviderModeLoad,
	hostedSystemFixture,
	installRuntimeTestHooks,
	installSuccessfulSystemctlFixture,
	loadCanonicalBundleFixture,
	loadRemoteRuntimeManifest,
	loadRuntimeManifest,
	readHermesConfigYaml,
	readSystemdEnvFile,
	readSystemdSystemUnit,
	readSystemdUserServiceConfig,
	root,
	runtimeInit,
	runtimeWatch,
	runtimeWatchLocaleManifest,
	seedMitmproxyCache,
	seedOpenClawBinary,
	seedRuntimeWatchLocaleBaseline,
	setRuntimeApplyGeneration,
	systemdEnvDigest,
	TEST_HOSTED_CODEX_SECRET_REF,
	TEST_HOSTED_CODEX_SECRET_VALUES,
	TEST_HOSTED_CODEX_TERMINAL_TOOLING,
	TEST_HOSTED_LOCALE,
	TEST_PROCESS_GID,
	TEST_PROCESS_UID,
	TEST_PROCESS_USER,
	TEST_RUNNING_CLI_SPEC,
	TEST_RUNNING_CLI_VERSION,
	TEST_RUNTIME_SERVICE_SECRET_VALUES,
	testBundleEtag,
	writeFakeOpenClawProviderAuthSdk,
	writeFakeSystemdManager,
	writeHermesDashboardPython,
	writeHermesVersionBinary,
	writeOpenClawConfigMutationFixture,
} from "../src/test-support/runtime-harness";
import { mockFetch } from "./commands/helpers";

installRuntimeTestHooks();

describe("runtime paths", () => {
	it("uses ~/.clawdi in local mode", () => {
		const home = join(root, "home", "alice");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "local";

		expect(detectRuntimeMode()).toBe("local");
		const paths = getRuntimePaths();
		expect(paths.mode).toBe("local");
		expect(paths.localConfig).toBe(join(home, ".clawdi", "config.json"));
		expect(paths.localAuth).toBe(join(home, ".clawdi", "auth.json"));
		expect(paths.workspaceRoot).toBe(join(home, "clawdi"));
		expect(paths.serviceStateRoot).toBe("/var/lib/clawdi");
		expect(paths.runRoot).toBe("/run/clawdi");
	});

	it("uses hosted runtime state and run path overrides", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = "root";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		expect(detectRuntimeMode()).toBe("hosted");
		const paths = getRuntimePaths();
		expect(paths.mode).toBe("hosted");
		expect(paths.userHome).toBe(home);
		expect(paths.workspaceRoot).toBe(home);
		expect(paths.cliManagedBin).toBe(join(state, "maintained", "clawdi", "bin", "clawdi"));
		expect(paths.cliNpmPrefix).toBe(join(state, "maintained", "clawdi", "npm"));
		expect(paths.cliNpmCache).toBe(join(root, "var", "cache", "clawdi", "npm"));
		expect(paths.egressProfileRoot).toBe(join(run, "egress"));
		expect(paths.egressProfileBundle).toBe(join(run, "egress", "profiles.json"));
	});

	it("reclaims a stale converge lock whose owner process is gone", () => {
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = "root";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const lockDir = join(run, "locks", "converge.lock");
		const ownerPath = join(lockDir, "owner.json");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			ownerPath,
			`${JSON.stringify({
				schemaVersion: "clawdi.runtimeConvergeLockOwner.v1",
				pid: 99_999_999,
				acquiredAt: "2026-06-06T00:00:00Z",
			})}\n`,
		);

		const result = withRuntimeConvergeLock(
			paths,
			() => {
				const owner = JSON.parse(readFileSync(ownerPath, "utf-8"));
				expect(owner.pid).toBe(process.pid);
				expect(readdirSync(join(run, "locks"))).toEqual(["converge.lock"]);
				return "locked";
			},
			{ timeoutMs: 10 },
		);

		expect(result).toBe("locked");
		expect(existsSync(lockDir)).toBe(false);
		expect(readdirSync(join(run, "locks"))).toEqual([]);
	});

	it("reclaims an ownerless converge lock only after the stale timeout window", () => {
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const lockDir = join(run, "locks", "converge.lock");
		mkdirSync(lockDir, { recursive: true });
		const fresh = new Date(Date.now() + 60_000);
		utimesSync(lockDir, fresh, fresh);

		expect(() => withRuntimeConvergeLock(paths, () => "locked", { timeoutMs: 5 })).toThrow(
			/timed out waiting/,
		);

		const stale = new Date(Date.now() - 60_000);
		utimesSync(lockDir, stale, stale);
		const result = withRuntimeConvergeLock(paths, () => "locked", { timeoutMs: 5 });

		expect(result).toBe("locked");
		expect(readdirSync(join(run, "locks"))).toEqual([]);
	});
});

describe("runtime run config", () => {
	it("uses the official Hermes gateway command by default", () => {
		const config = buildRuntimeRunConfig({
			runtime: "hermes",
			enabled: true,
			generatedAt: "2026-06-15T00:00:00.000Z",
			generation: 1,
			instanceId: "iid_hermes_ui",
			commandPath: "/home/clawdi/.local/bin/hermes",
			appRoot: "/home/clawdi/.hermes/hermes-agent",
			workspaceRoot: "/home/clawdi",
		});

		expect(config.defaultArgs).toEqual(["gateway", "run"]);
	});

	it("keeps built-in default args when run settings only add env", () => {
		const config = buildRuntimeRunConfig({
			runtime: "openclaw",
			enabled: true,
			generatedAt: "2026-07-01T00:00:00.000Z",
			generation: 1,
			instanceId: "iid_openclaw_env_only",
			commandPath: "/home/clawdi/.local/bin/openclaw",
			appRoot: "/home/clawdi/.openclaw",
			workspaceRoot: "/home/clawdi",
			settings: {
				env: { OPENCLAW_MODE: "hosted" },
				prependPath: [],
			},
		});

		expect(config.defaultArgs).toEqual(["gateway", "run"]);
		expect(config.env).toEqual({ OPENCLAW_MODE: "hosted" });
	});

	it("allows explicit empty args to override built-in defaults", () => {
		const config = buildRuntimeRunConfig({
			runtime: "openclaw",
			enabled: true,
			generatedAt: "2026-07-01T00:00:00.000Z",
			generation: 1,
			instanceId: "iid_openclaw_empty_args",
			commandPath: "/home/clawdi/.local/bin/openclaw",
			appRoot: "/home/clawdi/.openclaw",
			workspaceRoot: "/home/clawdi",
			settings: {
				args: [],
				env: {},
				prependPath: [],
			},
		});

		expect(config.defaultArgs).toEqual([]);
	});
});

describe("host policy", () => {
	it("uses the first-class built-in hosted contract", () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		const result = readHostPolicy();
		expect(result.valid).toBe(true);
		expect(result.source).toBe("builtin");
		expect(result.path).toBeUndefined();
		expect(result.policy?.systemWritableState).toEqual([
			"/etc/clawdi",
			"/var/lib/clawdi",
			"/var/cache/clawdi",
			"/run/clawdi",
		]);
		expect(result.policy?.userWritableState).toEqual(["/home/clawdi", "/tmp"]);
		expect(result.policy?.ordinaryUserDeniedState).toEqual([
			"/etc/clawdi",
			"/var/lib/clawdi",
			"/var/cache/clawdi",
		]);
		expect(deniedCommandReason(result.policy, "setup")).toBe(
			"runtime setup is managed by clawdi runtime init",
		);
		expect(deniedCommandReason(result.policy, "agent reconnect")).toBe(
			"Connected Agent identity can't be managed inside a Cloud Agent",
		);
		expect(deniedCommandReason(result.policy, "update")).toBe(
			"CLI updates are managed by the Cloud Agent runtime",
		);
		expect(deniedCommandReason(result.policy, "mcp")).toBe(null);
		expect(evaluateHostPolicyForCommand("mcp")).toEqual({
			allowed: true,
			command: "mcp",
			runtimeMode: "hosted",
			policySource: "builtin",
		});
	});

	it("ignores image policy files in hosted mode", () => {
		const path = join(root, "host-policy.json");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_HOST_POLICY_PATH = path;
		writeFileSync(path, "{not-json");

		const result = readHostPolicy(path);
		expect(result.exists).toBe(true);
		expect(result.valid).toBe(true);
		expect(result.source).toBe("builtin");
		expect(result.path).toBeUndefined();
	});

	it("does not infer hosted mode from a policy file", () => {
		const path = join(root, "host-policy.json");
		process.env.CLAWDI_HOST_POLICY_PATH = path;
		writeFileSync(path, "{}");
		expect(detectRuntimeMode()).toBe("local");
	});
});

describe("runtime applied content identity", () => {
	it("keeps low-entropy secret rotation private when a fixture has no ETag", () => {
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_identity",
			environmentId: "env_identity",
			instanceId: "iid_identity",
			generation: 1,
			issuedAt: "2026-07-13T00:00:00.000Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: {
				openclaw: {
					enabled: true,
					run: { secretEnv: { OPENAI_API_KEY: "secret://provider.default.apiKey" } },
				},
			},
			recovery: {},
		};
		const load = (secret: string): RuntimeManifestLoad => ({
			manifest,
			sourceBundle: manifest,
			secretValues: { "secret://provider.default.apiKey": secret },
			source: "remote-datasource",
			sourcePath: "inline-secret-identity",
			offline: false,
		});

		expect(runtimeAppliedContentIdentity(load("000000")).sha256).not.toBe(
			runtimeAppliedContentIdentity(load("000001")).sha256,
		);
		expect(runtimePublicContentRevision(load("000000"))).toBe(
			runtimePublicContentRevision(load("000001")),
		);
		const paths = getRuntimePaths({ mode: "hosted" });
		for (const secret of ["000000", "000001"]) {
			const cached: RuntimeManifestLoad = {
				...load(secret),
				source: "last-good-cache",
				offline: true,
				sourcePath: join(
					dirname(paths.manifestLastGood),
					`${runtimeAppliedContentIdentity(load(secret)).sha256}.json`,
				),
			};
			expect(runtimePublicSourcePath(cached, paths)).toBe(paths.manifestLastGood);
		}
		expect(runtimePublicSourcePath(load("000000"), paths)).toBe("inline-secret-identity");
	});
});

describe("runtime manifest datasource", () => {
	it.each([
		["watch", "rollback"],
		["init", "rollback"],
		["init", "readiness"],
		["watch", "ordinary"],
		["watch", "unknown-job"],
		["watch", "rollback-error"],
	] as const)(
		"handles preflight failure and CLI handoff: %s / %s",
		async (entrypoint, scenario) => {
			const home = join(root, "home", "clawdi");
			const paths = seedRuntimeWatchLocaleBaseline(home, join(root, "state"), join(root, "run"));
			reconcilePendingRuntimeCliUpgrade(paths, TEST_RUNNING_CLI_VERSION);
			const candidateTarget = readlinkSync(paths.cliManagedBin);
			const previous = createVersionedCliFixture(paths, "1.0.0-test");
			const receipt = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf8"));
			if (scenario !== "ordinary") {
				receipt.previous = { activeTarget: previous.activeTarget, version: previous.version };
				writeFileSync(paths.cliBootstrapStatus, JSON.stringify(receipt));
			}
			if (scenario === "rollback-error") rmSync(previous.activeTarget);
			const appliedBefore = readFileSync(paths.appliedState, "utf8");
			const manager = join(root, "manager");
			const wrapper = join(root, "systemctl");
			writeFakeSystemdManager({
				path: manager,
				logPath: join(root, "manager.log"),
				stateRoot: join(root, "manager-state"),
			});
			const transform =
				scenario === "unknown-job" ? "s/^Job=$/Job=7/" : "s/^ActiveState=.*/ActiveState=failed/";
			writeFileSync(
				wrapper,
				scenario === "unknown-job" || scenario === "readiness"
					? `#!/bin/sh
'${manager}' "$@" | sed '${transform}'
`
					: "#!/bin/sh\nprintf 'fixture systemctl show failed' >&2\nexit 1\n",
				{ mode: 0o755 },
			);
			process.env.CLAWDI_SYSTEMD_APPLY = "1";
			process.env.CLAWDI_SYSTEMCTL_PATH = wrapper;
			setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
			const etag = testBundleEtag("preflight-cli-rollback");
			const { restore, captured } = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () =>
						hostedRuntimeBundleResponse(hostedRuntimeWatchLocalePayload(home, 2), { etag }),
				},
			]);
			const logs: string[] = [];
			const priorLog = console.log;
			console.log = (value?: unknown) => logs.push(String(value));
			const abort = new AbortController();
			const deadline = setTimeout(() => abort.abort(), 5_000);
			process.exitCode = undefined;
			try {
				if (entrypoint === "init") await runtimeInit({ json: true, nonInteractive: true });
				else await runtimeWatch({ json: true, once: scenario !== "rollback", abort: abort.signal });
				expect(abort.signal.aborted).toBe(false);
				expect(captured.filter((request) => request.path === "/v1/runtime/manifest")).toHaveLength(
					1,
				);
				const event = JSON.parse(logs.at(-1) ?? "{}");
				expect(event.status).toBe("error");
				expect(readFileSync(paths.appliedState, "utf8")).toBe(appliedBefore);
				if (scenario === "unknown-job") {
					expect(event.error).toContain("unfinished work");
					expect(event.cliRollback).toBeUndefined();
					expect(event.selfReexec ?? false).toBe(false);
					expect(process.exitCode).toBe(1);
					expect(readlinkSync(paths.cliManagedBin)).toBe(candidateTarget);
					expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf8")).previous).toEqual(
						receipt.previous,
					);
					return;
				}
				expect(event.error).toContain(
					scenario === "readiness"
						? "transparent-egress system prerequisites did not reach readiness"
						: "fixture systemctl show failed",
				);
				expect(event.errors[0]).toBe(event.error);
				expect(event.rejectedGeneration).toBe(2);
				if (entrypoint === "watch") expect(event.etag).toBe(etag);
				if (scenario === "rollback" || scenario === "readiness") {
					expect(event.cliRollback.status).toBe("rolled_back");
					expect(event.selfReexec).toBe(true);
					expect(event.errors.join("\n")).toContain("rolled back clawdi CLI");
					expect(readlinkSync(paths.cliManagedBin)).toBe(previous.activeTarget);
					expect(JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf8"))).toMatchObject({
						version: previous.version,
						previous: null,
						bad: { version: TEST_RUNNING_CLI_VERSION },
					});
					if (entrypoint === "init") {
						expect(process.exitCode).toBe(75);
						expect(event.handoff).toBe("cli_reexec");
					} else expect(process.exitCode ?? 0).toBe(0);
				} else {
					expect(process.exitCode).toBe(1);
					expect(event.selfReexec ?? false).toBe(false);
					expect(readlinkSync(paths.cliManagedBin)).toBe(candidateTarget);
					if (scenario === "ordinary") expect(event.cliRollback).toBeUndefined();
					else {
						expect(event.cliRollback.status).toBe("error");
						expect(event.errors.join("\n")).toContain("failed to roll back clawdi CLI");
					}
				}
			} finally {
				clearTimeout(deadline);
				abort.abort();
				restore();
				console.log = priorLog;
				process.exitCode = 0;
			}
		},
	);

	it("keeps original failures visible when recovery is deferred by systemd or Hermes", () => {
		const paths = getRuntimePaths({ mode: "local" });
		const load: RuntimeManifestLoad = {
			manifest: runtimeWatchLocaleManifest(join(root, "home"), 2),
			source: "remote-datasource",
			sourcePath: "inline-deferred",
			offline: false,
			etag: testBundleEtag("deferred-errors"),
		};
		const convergence = runtimeConvergenceWithoutApply({
			load,
			paths,
			workspaceRoot: join(root, "home"),
			enabledRuntimes: [],
			installErrors: ["desired runtime install failed"],
			projectedProviderIds: {},
		});
		for (const reason of ["systemd_reobservation_required", "hermes_config_conflict"] as const) {
			expect(
				runtimeWatchEventForOutcome({ kind: "deferred", reason, load, convergence }, paths),
			).toMatchObject({
				status: "error",
				error: "desired runtime install failed",
				errors: ["desired runtime install failed"],
			});
		}
	});

	it("rejects the legacy /api runtime manifest path", () => {
		const parsed = runtimeManifestSourceSchema.safeParse({
			type: "http",
			url: "https://cloud-api.example.test/api/runtime/manifest?environment_id=env_runtime",
			auth: { type: "bearer", token: "test-runtime-token" },
		});
		expect(parsed.success).toBe(false);
	});

	it("fetches hosted-runtime manifests from a configured runtime source", async () => {
		setRuntimeApplyGeneration(3, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_test",
							environmentId: "env_test",
							...hostedRequiredState(),
							instanceId: "iid_remote",
							generation: 3,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime({
									provider_ids: ["default"],
								}),
							},
							providers: {
								default: {
									kind: "openai-compatible",
									type: "custom_openai_compatible",
									baseUrl: "https://sub2api.test/v1",
									models: [{ id: "gpt-5.5" }],
									apiMode: "openai_chat",
									managed_by: "clawdi",
									runtimeEnvName: "CLAWDI_AI_API_KEY",
									apiKeySecretRef: "secret://provider.default.apiKey",
								},
							},
							terminalTooling: TEST_HOSTED_CODEX_TERMINAL_TOOLING,
							skills: { entries: { clawdi: { enabled: true, version: 1 } } },
							tools: { catalog: "clawdi-default" },
						},
						secretValues: {
							"secret://provider.default.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			setRuntimeApplyGeneration(3, {
				...CANONICAL_TEST_CONTEXT,
				bootstrapBearer: "auth-token",
			});
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("manifest" in loaded).toBe(true);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			expect(captured).toHaveLength(1);
			expect(captured[0].headers.authorization).toBe("Bearer auth-token");
			expect(loaded.source).toBe("remote-datasource");
			expect(loaded.sourcePath).toBe("https://runtime.test/v1/runtime/manifest");
			expect(loaded.manifest.schemaVersion).toBe("clawdi.runtimeDesiredState.v1");
			expect(loaded.manifest.workspaceRoot).toBeUndefined();
			expect(loaded.manifest.environmentId).toBe("env_test");
			expect(loaded.manifest.controlPlane.apiUrl).toBe("https://cloud-api.test");
			expect(loaded.manifest.clawdiCli?.source).toBe("npm:clawdi");
			expect(loaded.manifest.clawdiCli?.packageSpec).toBe(TEST_RUNNING_CLI_SPEC);
			expect(loaded.manifest.projection?.skills).toEqual({
				entries: { clawdi: { enabled: true, version: 1 } },
			});
			expect(loaded.manifest.projection?.tools).toEqual({ catalog: "clawdi-default" });
			expect(loaded.manifest.projection?.terminalTooling).toEqual(
				TEST_HOSTED_CODEX_TERMINAL_TOOLING,
			);
			expect(loaded.manifest.runtimes.openclaw.install?.url).toBe(
				"https://openclaw.ai/install-cli.sh",
			);
			expect(loaded.manifest.runtimes.openclaw.install?.home).toBe(home);
			expect(loaded.manifest.runtimes.openclaw.install?.args).toEqual(
				officialInstallArgs("openclaw", home),
			);
			expectProviderEgressProfileUsesSecretRef(
				loaded.manifest.egressProfiles?.profiles,
				"secret://provider.default.apiKey",
				"sk-runtime",
			);
			expect(JSON.stringify(loaded.manifest.egressProfiles)).not.toContain("sk-runtime");
			expect(loaded.secretValues).toEqual({
				[TEST_HOSTED_CODEX_SECRET_REF]: "sk-codex-tool",
				"secret://clawdi/auth-token": "test-runtime-auth-token",
				"secret://provider.default.apiKey": "sk-runtime",
				"secret://runtime/openclaw/gateway-token": "test-openclaw-gateway-token",
			});
		} finally {
			restore();
		}
	});

	it("rejects a managed bootstrap tarball from a remote hosted manifest", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		const packageSpec = "/usr/local/share/clawdi/bootstrap/clawdi-1.2.3-test.tgz";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => hostedRuntimeBundleResponse(hostedCliManifestResponse(home, packageSpec)),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("errors" in loaded).toBe(true);
			if (!("errors" in loaded)) throw new Error("expected remote manifest rejection");
			expect(loaded.mode).toBe("manifest-rejected");
			expect(loaded.stage).toBe("network");
			expect(loaded.errors.join("\n")).toContain("must be clawdi@<exact-semver>");
		} finally {
			restore();
		}
	});

	for (const packageSpec of ["clawdi@latest", "clawdi"]) {
		it(`rejects ${packageSpec} from a remote hosted manifest`, async () => {
			const home = join(root, "home", "clawdi");
			const state = join(root, "var", "lib", "clawdi");
			mkdirSync(home, { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = join(root, "run", "clawdi");
			process.env.CLAWDI_AUTH_TOKEN = "auth-token";
			const { restore } = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () => hostedRuntimeBundleResponse(hostedCliManifestResponse(home, packageSpec)),
				},
			]);

			try {
				const loaded = await loadRuntimeManifest(getRuntimePaths());
				expect("errors" in loaded).toBe(true);
				if (!("errors" in loaded)) throw new Error("expected remote manifest rejection");
				expect(loaded.errors.join("\n")).toContain("must be clawdi@<exact-semver>");
			} finally {
				restore();
			}
		});
	}

	it("projects direct Hermes dashboard exposure", async () => {
		setRuntimeApplyGeneration(4, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const hermesInstaller = join(root, "install-hermes.sh");
		const hermesConfig = join(home, ".hermes", "config.yaml");
		mkdirSync(home, { recursive: true });
		mkdirSync(dirname(hermesConfig), { recursive: true });
		writeFileSync(
			hermesConfig,
			[
				"providers:",
				"  clawdi:",
				"    api: https://ai-gateway.test/v1",
				"    key_env: OPENAI_API_KEY",
				"    models:",
				"      gpt-5.5: {}",
				"    transport: openai_chat",
				"",
			].join("\n"),
		);
		writeFileSync(
			hermesInstaller,
			`#!/usr/bin/env bash
set -euo pipefail
install -d "$HOME/.local/bin"
cat > "$HOME/.local/bin/hermes" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf '%s\n' 'Hermes Agent v0.20.1 (2026-07-01)'
  exit 0
fi
if [ "\${1:-}" = "config" ]; then
  exec '${process.execPath}' '${HERMES_CONFIG_CLI_MOCK}' "$@"
fi
exit 0
SH
chmod +x "$HOME/.local/bin/hermes"
install -d "$HOME/.hermes/hermes-agent/venv/bin"
cat > "$HOME/.hermes/hermes-agent/venv/bin/python" <<'SH'
${hermesTestPythonScript(true)}
SH
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/python"
`,
		);
		chmodSync(hermesInstaller, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_HERMES_INSTALLER = hermesInstaller;
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "hermes",
							deploymentId: "dep_direct_hermes",
							environmentId: "env_direct_hermes",
							...hostedRequiredState(),
							instanceId: "iid_direct_hermes",
							generation: 4,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedHermesSystemFixture(home, join(home, "managed-workspace")),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								hermes: hostedHermesRuntime({
									provider_ids: ["clawdi"],
									primary_model: { provider_id: "clawdi", model: "gpt-5.5" },
								}),
							},
							providers: {
								clawdi: {
									kind: "openai-compatible",
									type: "custom_openai_compatible",
									baseUrl: "https://ai-gateway.test/v1",
									models: [{ id: "gpt-5.5" }],
									apiMode: "openai_chat",
									managed_by: "clawdi",
									runtimeEnvName: "CLAWDI_AI_API_KEY",
									apiKeySecretRef: "secret://provider.default.apiKey",
								},
							},
						},
						secretValues: {
							"secret://provider.default.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			const paths = getRuntimePaths();
			const loaded = await loadRuntimeManifest(paths);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			const provider = hostedAiProviderCatalog(loaded.manifest, "hermes")?.catalog.providers[0];
			expect(provider?.runtime_env_name).toBe("CLAWDI_AI_API_KEY");
			expectProviderEgressProfileUsesSecretRef(
				loaded.manifest.egressProfiles?.profiles,
				"secret://provider.default.apiKey",
				"sk-runtime",
			);
			const convergence = convergeRuntimeManifest(loaded, paths);
			expect(convergence.installErrors).toEqual([]);
			const hermesEnv = readSystemdEnvFile(paths, "hermes-gateway");
			const hermesDashboardEnv = readSystemdEnvFile(paths, "clawdi-hermes-dashboard");
			const hermesRunConfig = expectRecord(
				JSON.parse(readFileSync(join(paths.runConfigRoot, "hermes.json"), "utf-8")),
				"Hermes run config",
			);
			const hermesDashboardRunConfig = expectRecord(
				JSON.parse(readFileSync(join(paths.runConfigRoot, "hermes+dashboard.json"), "utf-8")),
				"Hermes dashboard run config",
			);
			const providers = expectRecord(readHermesConfigYaml(home).providers, "Hermes providers");
			const managedProvider = expectRecord(providers.clawdi, "Hermes managed provider");
			const hermesRunEnv = expectRecord(hermesRunConfig.env, "Hermes run environment");
			const hermesDashboardRunEnv = expectRecord(
				hermesDashboardRunConfig.env,
				"Hermes dashboard run environment",
			);

			expect(convergence.outputs.systemdSystemUnits).toContain(
				join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"),
			);
			expect(managedProvider.key_env).toBe("CLAWDI_AI_API_KEY");
			expect(hermesEnv).toContain('CLAWDI_AI_API_KEY="clawdi-egress-placeholder"');
			expect(hermesEnv).not.toMatch(/^OPENAI_API_KEY=/m);
			expect(hermesDashboardEnv).toContain('CLAWDI_AI_API_KEY="clawdi-egress-placeholder"');
			expect(hermesDashboardEnv).not.toMatch(/^OPENAI_API_KEY=/m);
			expect(hermesRunEnv.CLAWDI_AI_API_KEY).toBe("clawdi-egress-placeholder");
			expect(hermesRunEnv.OPENAI_API_KEY).toBeUndefined();
			expect(hermesDashboardRunEnv.CLAWDI_AI_API_KEY).toBe("clawdi-egress-placeholder");
			expect(hermesDashboardRunEnv.OPENAI_API_KEY).toBeUndefined();
			expectEgressProfileBundleUsesSecretRef(
				convergence.outputs.egressProfileBundle,
				"secret://provider.default.apiKey",
				"sk-runtime",
			);
			if (!convergence.outputs.egressProfileBundle) {
				throw new Error("expected managed provider egress profile bundle");
			}
			const egressProfileBundle = readFileSync(convergence.outputs.egressProfileBundle, "utf-8");
			expect(egressProfileBundle).toContain('"value": "clawdi-egress-placeholder"');
			expect(readSystemdUserServiceConfig(paths, "hermes-gateway")).not.toContain("sk-runtime");
			expect(readSystemdUserServiceConfig(paths, "clawdi-hermes-dashboard")).not.toContain(
				"sk-runtime",
			);
		} finally {
			restore();
		}
	});

	it("withdraws only an incompatible Hermes dashboard and never reinstalls for it", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const installer = join(root, "install-hermes.sh");
		const installerCalls = join(root, "install-hermes.calls");
		const appMarker = join(home, ".hermes", "hermes-agent", "repair-marker");
		const skillMarker = join(home, ".hermes", "skills", "user-skill", "content.txt");
		const command = writeHermesVersionBinary(home, "0.20.1");
		writeHermesDashboardPython(home, false);
		mkdirSync(dirname(skillMarker), { recursive: true });
		writeFileSync(appMarker, "before-repair\n");
		writeFileSync(skillMarker, "user-skill-before-repair\n");
		writeFileSync(
			installer,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' install >> '${installerCalls}'
install -d "$HOME/.local/bin" "$HOME/.hermes/hermes-agent/venv/bin" "$HOME/.hermes/skills/user-skill"
cat > "$HOME/.local/bin/hermes" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'Hermes Agent v0.20.1 (2026-07-01)'
  exit 0
fi
if [ "\${1:-}" = "config" ]; then
  exec '${process.execPath}' '${HERMES_CONFIG_CLI_MOCK}' "$@"
fi
exit 0
SH
chmod +x "$HOME/.local/bin/hermes"
printf '%s\\n' installer-mutated > "$HOME/.hermes/hermes-agent/repair-marker"
printf '%s\\n' installer-mutated > "$HOME/.hermes/skills/user-skill/content.txt"
cat > "$HOME/.hermes/hermes-agent/venv/bin/python" <<'SH'
${hermesTestPythonScript(true)}
SH
chmod +x "$HOME/.hermes/hermes-agent/venv/bin/python"
`,
		);
		chmodSync(installer, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_HERMES_INSTALLER = installer;
		const paths = getRuntimePaths();
		const load = hostedHermesDashboardCapabilityLoad(home);

		const degraded = convergeRuntimeManifest(load, paths);
		expect(degraded.installErrors).toEqual([]);
		expect(degraded.resourceProjectionErrors).toEqual([
			`runtime hermes dashboard unavailable: Hermes dashboard runtime is incompatible; see ${join(paths.statusRoot, "installer-logs", "hermes-dashboard-capability.log")}`,
		]);
		expect(
			readFileSync(
				join(paths.statusRoot, "installer-logs", "hermes-dashboard-capability.log"),
				"utf8",
			),
		).toContain("missing capture_signals");
		expect(readSystemdUserServiceConfig(paths, "hermes-gateway")).not.toBe("\n");
		expect(readSystemdUserServiceConfig(paths, "clawdi-hermes-dashboard")).toBe("\n");
		expect(degraded.serviceWithdrawals).toEqual([{ runtime: "hermes", service: "dashboard" }]);
		expect(existsSync(installerCalls)).toBe(false);
		expect(readFileSync(appMarker, "utf8")).toBe("before-repair\n");
		expect(readFileSync(skillMarker, "utf8")).toBe("user-skill-before-repair\n");

		rmSync(command);
		const installed = convergeRuntimeManifest(load, paths);
		expect(installed.installErrors).toEqual([]);
		expect(installed.resourceProjectionErrors).toEqual([]);
		expect(installed.serviceWithdrawals).toEqual([]);
		expect(readSystemdUserServiceConfig(paths, "clawdi-hermes-dashboard")).not.toBe("\n");
		expect(readFileSync(installerCalls, "utf8").trim().split("\n")).toEqual(["install"]);
	});

	it("keeps explicit OpenAI chat providers on direct provider projection", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_chat_provider",
							environmentId: "env_chat_provider",
							...hostedRequiredState(),
							instanceId: "iid_chat_provider",
							generation: 1,
							issuedAt: "2026-06-22T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime(),
							},
							providers: {
								default: {
									kind: "openai-compatible",
									type: "custom_openai_compatible",
									baseUrl: "https://ai-gateway.example.test/v1",
									models: [{ id: "gpt-5.4-mini" }],
									apiMode: "openai_chat",
									managed_by: "clawdi",
									runtimeEnvName: "CLAWDI_AI_API_KEY",
									apiKeySecretRef: "secret://provider.default.apiKey",
								},
							},
						},
						secretValues: {
							"secret://provider.default.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("manifest" in loaded).toBe(true);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			expect(loaded.manifest.projection?.providers.default).toMatchObject({
				baseUrl: "https://ai-gateway.example.test/v1",
				models: [{ id: "gpt-5.4-mini" }],
				apiMode: "openai_chat",
				runtimeEnvName: "CLAWDI_AI_API_KEY",
			});
			expect(
				loaded.manifest.egressProfiles?.profiles.find(
					(profile) => profile.id === "managed-provider",
				),
			).toMatchObject({
				id: "managed-provider",
				enabled: true,
				kind: "provider",
				match: {
					scheme: "https",
					host: "ai-gateway.example.test",
				},
				rewrite: {
					setHeaders: {
						authorization: {
							type: "secretRef",
							secretRef: "secret://provider.default.apiKey",
							prefix: "Bearer ",
						},
					},
				},
				owner: "provider-projection",
			});
			expect(JSON.stringify(loaded.manifest.egressProfiles)).not.toContain("sk-runtime");
		} finally {
			restore();
		}
	});

	it("derives sidecar-only provider egress profiles from hosted-runtime manifests", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_AUTH_TOKEN = "runtime-auth-token";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_codex_provider",
							environmentId: "env_codex_provider",
							...hostedRequiredState(),
							instanceId: "iid_codex_provider",
							generation: 1,
							issuedAt: "2026-06-22T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime(),
							},
							providers: {
								default: {
									kind: "openai-compatible",
									type: "custom_openai_compatible",
									baseUrl: "https://ai-gateway.example.test/v1",
									models: [{ id: "gpt-5.4-mini" }],
									apiMode: "openai_responses",
									managed_by: "clawdi",
									runtimeEnvName: "CLAWDI_AI_API_KEY",
									apiKeySecretRef: "secret://provider.default.apiKey",
								},
							},
						},
						secretValues: {
							"secret://provider.default.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("manifest" in loaded).toBe(true);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			expect(
				loaded.manifest.egressProfiles?.profiles.find(
					(profile) => profile.id === "managed-provider",
				),
			).toMatchObject({
				id: "managed-provider",
				enabled: true,
				kind: "provider",
				match: {
					scheme: "https",
					host: "ai-gateway.example.test",
				},
				rewrite: {
					setHeaders: {
						authorization: {
							type: "secretRef",
							secretRef: "secret://provider.default.apiKey",
							prefix: "Bearer ",
						},
					},
				},
				owner: "provider-projection",
			});
			expect(JSON.stringify(loaded.manifest.egressProfiles)).not.toContain("sk-runtime");
		} finally {
			restore();
		}
	});

	it("keeps provider secrets sidecar-only for hosted runtime manifest responses", async () => {
		setRuntimeApplyGeneration(5, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "hosted-runtime-response.json");
		writeOpenClawConfigMutationFixture(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
			join(root, "provider-secret-auth"),
			join(root, "provider-secret-auth", "calls.log"),
		);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "openclaw",
					deploymentId: "dep_hosted_provider_secret",
					environmentId: "env_hosted_provider_secret",
					...hostedRequiredState(),
					instanceId: "iid_hosted_provider_secret",
					generation: 5,
					issuedAt: "2026-06-15T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime({
							provider_ids: ["clawdi-managed-v2"],
							primary_model: {
								provider_id: "clawdi-managed-v2",
								model: "gpt-5.5",
							},
						}),
					},
					providers: {
						"clawdi-managed-v2": {
							kind: "openai-compatible",
							type: "custom_openai_compatible",
							baseUrl: "https://ai-gateway.example.test/v1",
							models: [{ id: "gpt-5.5" }],
							apiMode: "openai_chat",
							managed_by: "clawdi",
							runtimeEnvName: "CLAWDI_AI_API_KEY",
							apiKeySecretRef: "secret://tool.codex.apiKey",
						},
					},
					recovery: { cacheManifest: true, allowOfflineBoot: true },
				},
				secretValues: {
					"secret://tool.codex.apiKey": "sk-runtime-provider",
				},
			}),
		);
		setRuntimeApplyGeneration(5, CANONICAL_TEST_CONTEXT);

		const loaded = await loadCanonicalBundleFixture(manifestPath);
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected hosted manifest load success");

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const runConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
		);
		expect(runConfig.env.CLAWDI_AI_API_KEY).toBe("clawdi-egress-placeholder");
		expect(runConfig.env.OPENAI_API_KEY).toBeUndefined();
		expect(runConfig.secretEnv).toEqual({
			OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
		});
		expect(runConfig.secretFilePath).toBeNull();
		expect(JSON.stringify(runConfig)).not.toContain("sk-runtime-provider");
		expectExistingFileNotToContain(
			join(run, "secrets", "runtime-secrets.json"),
			"sk-runtime-provider",
		);
		const paths = getRuntimePaths();
		expectEgressProfileBundleUsesSecretRef(
			convergence.outputs.egressProfileBundle,
			"secret://tool.codex.apiKey",
			"sk-runtime-provider",
		);
		expectMitmSecretFileIsSidecarOnly(
			paths,
			convergence.outputs.egressSecretFile,
			"secret://tool.codex.apiKey",
			"sk-runtime-provider",
		);
		expect(existsSync(join(run, "secrets", "runtimes", "openclaw.json"))).toBe(false);
	});

	it("does not project a key-required hosted provider without a secret ref as no-auth", async () => {
		delete process.env.OPENCLAW_GATEWAY_TOKEN;
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-provider-patch.json");
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeFileSync(
			openclawBin,
			[
				"#!/bin/sh",
				'if [ "$1 $2 $3" = "config patch --stdin" ]; then',
				`  cat > '${openclawPatch}'`,
				"  exit 0",
				"fi",
				"exit 2",
				"",
			].join("\n"),
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		seedMitmproxyCache();
		const fixture = hostedCliManifestResponse(home, TEST_RUNNING_CLI_SPEC);
		fixture.manifest.runtimes = {
			openclaw: hostedOpenClawRuntime({
				provider_ids: ["openclaw"],
				primary_model: { provider_id: "openclaw", model: "claude-opus-4-6" },
			}),
		};
		fixture.manifest.providers = {
			openclaw: {
				kind: "openai-compatible",
				type: "anthropic",
				baseUrl: "https://api.anthropic.com",
				apiMode: "anthropic_messages",
				apiKeyRequired: true,
				status: "error",
				error: {
					code: "provider_secret_unavailable",
					message: "provider secret is unavailable",
				},
			},
		};
		const loaded = parseHostedRuntimeBundleV2(
			{
				schemaVersion: "clawdi.hosted-runtime.bundle.v2",
				sourceRevision: "f".repeat(64),
				manifest: fixture.manifest,
				channelBindings: [],
				secretValues: {
					...TEST_HOSTED_CODEX_SECRET_VALUES,
					...TEST_RUNTIME_SERVICE_SECRET_VALUES,
				},
			},
			"https://runtime-source.test/desired-state",
		);

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const providerHealth = (await readHostedRuntimeObserved(getRuntimePaths()))?.providers
			?.openclaw;
		expect(providerHealth?.status).toBe("error");
		expect(providerHealth?.reasons).toContain("provider_error");
		expect(providerHealth?.reasons).toContain("provider_secret_unavailable");
		expect(providerHealth?.reasons).toContain("api_key_secret_ref_missing");
	});

	it("loads only the selected hosted runtime entry", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "hosted-runtime-selected-entry.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "openclaw",
					deploymentId: "dep_selected_runtime",
					environmentId: "env_selected_runtime",
					...hostedRequiredState(),
					instanceId: "iid_selected_runtime",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
					},
				},
				secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
			}),
		);
		setRuntimeApplyGeneration(1, CANONICAL_TEST_CONTEXT);

		const loaded = await loadCanonicalBundleFixture(manifestPath);

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		expect(loaded.manifest.runtimes.openclaw.enabled).toBe(true);
		expect(loaded.manifest.runtimes).not.toHaveProperty("hermes");
	});

	it("rejects hosted-runtime manifests that declare a disabled sibling runtime", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "hosted-runtime-disabled-sibling.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "openclaw",
					deploymentId: "dep_disabled_sibling",
					environmentId: "env_disabled_sibling",
					...hostedRequiredState(),
					instanceId: "iid_disabled_sibling",
					generation: 1,
					issuedAt: "2026-06-15T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
						hermes: hostedHermesRuntime({ enabled: false }),
					},
				},
				secretValues: {},
			}),
		);
		setRuntimeApplyGeneration(1, CANONICAL_TEST_CONTEXT);

		const loaded = await loadCanonicalBundleFixture(manifestPath);

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors.join("\n")).toContain(
			"hosted runtime manifests must declare exactly one selected runtime",
		);
	});

	it("uses the canonical context bearer without mutating the durable token file", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		mkdirSync(join(run, "secrets"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		// Legacy ambient selectors and tokens are deliberately stale. Hosted v2
		// fetch authority comes only from the canonical context.
		process.env.CLAWDI_AUTH_TOKEN = "stale-default-token";
		process.env.CUSTOM_RUNTIME_TOKEN = "stale-selected-token";
		setRuntimeApplyGeneration(1, {
			...CANONICAL_TEST_CONTEXT,
			bootstrapBearer: "context-runtime-token",
		});
		const paths = getRuntimePaths();
		writeFileSync(paths.daemonAuthToken, "stale-file-token\n");
		const fixedTokenTime = new Date("2026-07-30T00:00:00.000Z");
		utimesSync(paths.daemonAuthToken, fixedTokenTime, fixedTokenTime);
		const tokenMtimeBeforeFetch = statSync(paths.daemonAuthToken).mtimeMs;
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "hermes",
							deploymentId: "dep_custom_auth",
							environmentId: "env_custom_auth",
							...hostedRequiredState(),
							instanceId: "iid_custom_auth",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedHermesSystemFixture(home),
							controlPlane: { cloudApiUrl: "https://cloud-api.test" },
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: { hermes: hostedHermesRuntime() },
						},
						secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(paths);
			if (!("manifest" in loaded)) throw new Error(loaded.errors.join("\n"));
			expect(captured[0].headers.authorization).toBe("Bearer context-runtime-token");
			expect(readFileSync(paths.daemonAuthToken, "utf-8")).toBe("stale-file-token\n");
			expect(statSync(paths.daemonAuthToken).mtimeMs).toBe(tokenMtimeBeforeFetch);
		} finally {
			restore();
		}
	});

	it("reuses manifest-managed MCP auth across watch generations and offline rebuild", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const bootstrapToken = "bootstrap-transport-token";
		const runtimeAuthToken = "runtime-business-token";
		mkdirSync(dirname(openclawBin), { recursive: true });
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "stale-process-token";
		const paths = getRuntimePaths();
		const egressEngine = seedMitmproxyCache(paths);
		const payload = (generation: number): HostedRuntimeResponseFixture => ({
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				runtime: "openclaw",
				deploymentId: "dep_same_token",
				environmentId: "env_same_token",
				...hostedRequiredState(),
				instanceId: "iid_same_token",
				generation,
				issuedAt: `2026-06-06T00:0${generation - 1}:00Z`,
				locale: TEST_HOSTED_LOCALE,
				system: hostedSystemFixture(home),
				controlPlane: { cloudApiUrl: "https://cloud-api.test" },
				egressEngine,
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: TEST_RUNNING_CLI_SPEC,
					registry: "https://registry.npmjs.org",
				},
				runtimes: { openclaw: hostedOpenClawRuntime() },
				mcp: {
					servers: {
						clawdi: {
							url: "https://cloud-api.test/v1/mcp/clawdi",
							transport: "streamable-http",
							headers: {
								Authorization: {
									secretRef: "secret://clawdi/auth-token",
									prefix: "Bearer ",
								},
							},
						},
					},
				},
				liveSync: {
					enabled: true,
					agents: [{ agentType: "openclaw", environmentId: "env_same_token" }],
				},
			},
			secretValues: { "secret://clawdi/auth-token": runtimeAuthToken },
		});
		let manifestFetches = 0;
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => {
					manifestFetches++;
					if (manifestFetches === 1) return hostedRuntimeBundleResponse(payload(1));
					if (manifestFetches === 2) return hostedRuntimeBundleResponse(payload(2));
					throw new Error("control plane unavailable");
				},
			},
		]);

		try {
			setRuntimeApplyGeneration(1, {
				...CANONICAL_TEST_CONTEXT,
				bootstrapBearer: bootstrapToken,
			});
			const initial = await loadRuntimeManifest(paths);
			if (!("manifest" in initial)) throw new Error("expected initial manifest load success");
			const apply = (load: RuntimeManifestLoad) =>
				convergeRuntimeManifest(load, paths, {
					systemdApply: {
						activateEgressPrerequisite: () => ({
							applied: true,
							systemUnitsChanged: [],
							userUnitsChanged: [],
						}),
						activate: () => ({
							applied: true,
							systemUnitsChanged: [],
							userUnitsChanged: [],
						}),
					},
					commitAuthority: (convergence, authority) => {
						if (!load.sourceRevision) throw new Error("expected runtime source revision");
						commitRuntimeAppliedState({
							load,
							paths,
							etag: load.etag ?? `"managed-mcp-${load.manifest.generation}"`,
							sourceRevision: load.sourceRevision,
							convergence,
							applyIdentity: load.applyContext?.identity ?? null,
							activated: authority.activated,
							officialServiceCommandRevisions: authority.officialServiceCommandRevisions,
						});
					},
				});
			const convergence = apply(initial);
			expect(convergence.installErrors).toEqual([]);
			const watchEnv = readSystemdEnvFile(paths, "clawdi-runtime-watch");
			for (const line of watchEnv.split("\n")) {
				const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(".*")$/);
				if (!match) continue;
				const [, name, encodedValue] = match;
				if (!name || !encodedValue) throw new Error("invalid generated watcher environment");
				const value = JSON.parse(encodedValue) as unknown;
				if (typeof value !== "string")
					throw new Error("invalid generated watcher environment value");
				process.env[name] = value;
			}
			process.env.CLAWDI_RUNTIME_UID = String(process.geteuid?.() ?? process.getuid?.() ?? 0);
			setRuntimeApplyGeneration(2, {
				...CANONICAL_TEST_CONTEXT,
				bootstrapBearer: bootstrapToken,
			});
			const watched = await loadRemoteRuntimeManifest(paths);
			if (!("manifest" in watched) || "notModified" in watched) {
				throw new Error("expected next watcher generation");
			}
			const watchedConvergence = apply(watched);
			expect(watchedConvergence.installErrors).toEqual([]);
			const egressSecretFile = watchedConvergence.outputs.egressSecretFile;
			if (!egressSecretFile) throw new Error("expected managed MCP egress secret file");
			const onlineEgressSecrets = readFileSync(egressSecretFile, "utf-8");

			process.env.CLAWDI_AUTH_TOKEN = "";
			rmSync(egressSecretFile);
			const offline = await loadRuntimeManifest(paths);
			if (!("manifest" in offline)) throw new Error(offline.errors.join("\n"));
			const offlineConvergence = convergeRuntimeManifest(offline, paths, {
				cacheLastGood: false,
			});

			expect(watched.manifest.generation).toBe(2);
			expect(offline.source).toBe("last-good-cache");
			expect(offlineConvergence.mode).toBe("degraded-offline");
			expect(offlineConvergence.installErrors).toEqual([]);
			expect(readFileSync(egressSecretFile, "utf-8")).toBe(onlineEgressSecrets);
			expect(onlineEgressSecrets).toContain(runtimeAuthToken);
			expect(captured.map((entry) => entry.url)).toEqual([
				"https://runtime.test/v1/runtime/manifest",
				"https://runtime.test/v1/runtime/manifest",
				"https://runtime.test/v1/runtime/manifest",
			]);
			expect(captured.map((entry) => entry.headers.authorization)).toEqual([
				`Bearer ${bootstrapToken}`,
				`Bearer ${bootstrapToken}`,
				`Bearer ${bootstrapToken}`,
			]);
			expect(convergence.outputs.daemonAuthTokenFile).toBe(join(run, "secrets", "auth-token"));
			expect(readFileSync(join(run, "secrets", "auth-token"), "utf-8")).toBe(
				`${runtimeAuthToken}\n`,
			);
			expect(statSync(join(run, "secrets", "auth-token")).mode & 0o777).toBe(0o600);
			expect(statSync(egressSecretFile).mode & 0o777).toBe(0o600);
			if (typeof process.getuid === "function" && process.getuid() === 0) {
				expect(statSync(join(run, "secrets", "auth-token")).uid).toBe(0);
				expect(statSync(join(run, "secrets", "auth-token")).gid).toBe(0);
			}
			expect(watchEnv).toContain('CLAWDI_AUTH_TOKEN=""');
			expect(process.env.CLAWDI_AUTH_TOKEN).toBe("");
			expect(watchEnv).not.toContain("CLAWDI_HOST_POLICY_PATH");
			expect(watchEnv).not.toContain("CLAWDI_RUNTIME_SOURCE_PATH");
			expect(watchEnv).not.toContain(runtimeAuthToken);
			for (const unitPath of convergence.outputs.systemdSystemUnits) {
				expect(readFileSync(unitPath, "utf-8")).not.toContain(runtimeAuthToken);
			}
			for (const entry of readdirSync(paths.systemdEnvRoot)) {
				expect(readFileSync(join(paths.systemdEnvRoot, entry), "utf-8")).not.toContain(
					runtimeAuthToken,
				);
			}
			expect(readFileSync(paths.appliedState, "utf-8")).not.toContain(runtimeAuthToken);
			expect(JSON.stringify(convergence)).not.toContain(runtimeAuthToken);
			expect(JSON.stringify(watchedConvergence)).not.toContain(runtimeAuthToken);
		} finally {
			restore();
		}
	});

	it("loads remote manifests with If-None-Match and the canonical context bearer", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "";
		const currentEtag = testBundleEtag("etag-current");
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					new Response(null, {
						status: 304,
						headers: { etag: currentEtag },
					}),
			},
		]);

		try {
			const loaded = await loadRemoteRuntimeManifest(getRuntimePaths(), {
				ifNoneMatch: currentEtag,
			});

			expect("notModified" in loaded).toBe(true);
			if (!("notModified" in loaded)) throw new Error("expected 304 manifest load");
			expect(loaded.etag).toBe(currentEtag);
			expect(captured).toHaveLength(1);
			expect(captured[0].headers.authorization).toBe("Bearer test-runtime-bootstrap-token");
			expect(captured[0].headers["if-none-match"]).toBe(currentEtag);
		} finally {
			restore();
		}
	});

	it("fails closed instead of selecting a historical duplicate runtime account", () => {
		for (const runtime of ["openclaw", "hermes"] as const) {
			for (const provider of ["telegram", "discord"] as const) {
				const firstAccount = "clawdi_00000000000000000000000000000001";
				const secondAccount = "clawdi_00000000000000000000000000000002";
				const agentRef = (account: string) =>
					`secret://channels/${provider}/${account}/agent-token`;
				const placeholderRef = (account: string) =>
					`secret://channels/${provider}/${account}/placeholder-token`;
				const bindings: RuntimeBundleChannelBinding[] = [firstAccount, secondAccount].map(
					(accountKey) => ({
						provider,
						accountKey,
						agentTokenSecretRef: agentRef(accountKey),
						placeholderTokenSecretRef: placeholderRef(accountKey),
					}),
				);
				const loaded: RuntimeManifestLoad = {
					manifest: {
						schemaVersion: "clawdi.runtimeDesiredState.v1",
						deploymentId: `dep_duplicate_${runtime}_${provider}`,
						environmentId: `env_duplicate_${runtime}_${provider}`,
						instanceId: `iid_duplicate_${runtime}_${provider}`,
						generation: 1,
						issuedAt: "2026-07-30T00:00:00Z",
						controlPlane: { apiUrl: "https://cloud-api.test" },
						runtimes: { [runtime]: { enabled: true } },
					},
					source: "remote-datasource",
					sourcePath: "https://cloud-api.test/v1/runtime/manifest",
					channelBindings: bindings,
					secretValues: Object.fromEntries(
						bindings.flatMap((binding, index) => [
							[binding.agentTokenSecretRef, `agent-token-${index}`],
							[binding.placeholderTokenSecretRef, `99999999${index}:${"a".repeat(32)}`],
						]),
					),
				};
				const label = provider === "telegram" ? "Telegram" : "Discord";

				expect(() => applyRuntimeBundleChannelsToManifestLoad(loaded)).toThrow(
					`This Agent has multiple active ${label} bots. Unlink the extras until only one remains.`,
				);
			}
		}
	});

	it("derives hosted workspace and explicit process cwd from HOME", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = home;
		writeHermesVersionBinary(home, "0.18.0");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "hermes",
							deploymentId: "dep_workspace",
							environmentId: "env_workspace",
							...hostedRequiredState(),
							instanceId: "iid_workspace",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedHermesSystemFixture(home, workspace),
							controlPlane: { cloudApiUrl: "https://cloud-api.test" },
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								hermes: hostedHermesRuntime({}),
							},
						},
						secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("manifest" in loaded).toBe(true);
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
			const hermesRunConfig = JSON.parse(
				readFileSync(join(getRuntimePaths().runConfigRoot, "hermes.json"), "utf-8"),
			);

			expect(convergence.outputs.workspaceRoot).toBe(workspace);
			expect(existsSync(workspace)).toBe(true);
			expect(hermesRunConfig.cwd).toBe(workspace);
			expect(expectRecord(readHermesConfigYaml(home).terminal, "Hermes terminal config").cwd).toBe(
				workspace,
			);
			expect(convergence.outputs.processManager).toBe("systemd");
			expect(readSystemdSystemUnit(getRuntimePaths(), "clawdi-runtime-watch")).toContain(
				`WorkingDirectory=${workspace}`,
			);
		} finally {
			restore();
		}
	});

	it("rejects legacy hosted controlPlane apiUrl", async () => {
		const home = join(root, "home", "clawdi");
		const manifestPath = join(root, "hosted-legacy-api-url.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "hermes",
					deploymentId: "dep_legacy_api_url",
					environmentId: "env_legacy_api_url",
					...hostedRequiredState(),
					instanceId: "iid_legacy_api_url",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { apiUrl: "https://api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						hermes: hostedHermesRuntime(),
					},
				},
				secretValues: {},
			}),
		);

		const loaded = await loadCanonicalBundleFixture(manifestPath);

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		if (loaded.mode !== "manifest-rejected") throw new Error(loaded.errors.join("\n"));
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors.join("\n")).toContain("apiUrl");
	});

	it.each(["liveSync", "recovery"] as const)(
		"rejects hosted manifests without required %s state",
		async (field) => {
			const home = join(root, "home", "clawdi");
			const manifestPath = join(root, `hosted-missing-${field}.json`);
			mkdirSync(home, { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			const payload = hostedRuntimeWatchLocalePayload(home, 1) as {
				manifest: Record<string, unknown>;
			};
			delete payload.manifest[field];
			writeFileSync(manifestPath, JSON.stringify(payload));

			const loaded = await loadCanonicalBundleFixture(manifestPath);

			expect("errors" in loaded).toBe(true);
			if (!("errors" in loaded)) throw new Error("expected manifest load failure");
			expect(loaded.mode).toBe("manifest-rejected");
			expect(loaded.errors.join("\n")).toContain(`manifest.${field}`);
		},
	);

	it("uses derived hosted HOME as cwd without explicit run settings", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "runtime-workspace.json");
		writeHermesVersionBinary(home, "0.18.0");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		seedMitmproxyCache();
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "hermes",
					deploymentId: "dep_runtime_workspace",
					environmentId: "env_runtime_workspace",
					...hostedRequiredState(),
					instanceId: "iid_runtime_workspace",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedHermesSystemFixture(home, join(home, "system-workspace")),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						hermes: hostedHermesRuntime({}),
					},
				},
				secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
			}),
		);

		const loaded = await loadCanonicalBundleFixture(manifestPath);
		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths(), {});
		const hermesRunConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "hermes.json"), "utf-8"),
		);
		const hermesDashboardRunConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "hermes+dashboard.json"), "utf-8"),
		);

		expect(convergence.outputs.workspaceRoot).toBe(home);
		expect(hermesRunConfig.cwd).toBe(home);
		expect(hermesRunConfig.defaultArgs).toEqual(["gateway", "run"]);
		expect(hermesDashboardRunConfig.cwd).toBe(home);
		expect(hermesDashboardRunConfig.defaultArgs).toEqual([
			"dashboard",
			"--host",
			"0.0.0.0",
			"--port",
			"9119",
			"--no-open",
		]);
	});

	it("runs the egress-only sidecar with a lifecycle nft redirect", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const load = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 1);
		load.manifest.runtimes.openclaw.install = undefined;
		load.manifest.egressProfiles?.profiles.push({
			id: "deny-metadata",
			enabled: true,
			kind: "deny",
			match: {
				scheme: "https",
				host: "169.254.169.254",
				pathPrefix: "/",
			},
			priority: 1,
		});
		convergeRuntimeManifest(load, getRuntimePaths());

		const paths = getRuntimePaths();
		const sidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
		const sidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
		const initialSidecarRevision = systemdEnvDigest(sidecarEnv);
		const transparentEgressEnv = readFileSync(paths.egressTransparentEnv, "utf-8");
		const openclawUnit = readSystemdUserServiceConfig(paths, "openclaw-gateway");
		const openclawEnv = readSystemdEnvFile(paths, "openclaw-gateway");
		expect(sidecarUnit).toContain("Type=notify");
		expect(sidecarUnit).toContain(`Before=user@${TEST_PROCESS_UID}.service`);
		expect(sidecarUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "sidecar"`);
		expect(sidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
		expect(transparentEgressEnv).toContain(
			'CLAWDI_EGRESS_TRANSPORT_VERSION="clawdi-transparent-egress-v1"',
		);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_TRANSPARENT_PORT="${TRANSPARENT_EGRESS_PORT}"`,
		);
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_NFT_TABLE="clawdi_transparent_egress"');
		expect(transparentEgressEnv).toContain(`CLAWDI_RUNTIME_UID="${TEST_PROCESS_UID}"`);
		expect(transparentEgressEnv).toContain(`CLAWDI_RUNTIME_GID="${TEST_PROCESS_GID}"`);
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_UID="10002"');
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_GID="10002"');
		expect(sidecarEnv).toContain(
			`CLAWDI_EGRESS_ENV_FILE="${join(run, "egress", "transparent-egress.env")}"`,
		);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_PROFILE_BUNDLE="${getRuntimePaths().egressProfileBundle}"`,
		);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_SYSTEM_CA_BUNDLE="${join(run, "egress", "systemd", "ca.pem")}"`,
		);
		expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_ADDON_PATH="${paths.egressAddon}"`);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_ENGINE_BINARY_PATH="${paths.egressServiceBinary}"`,
		);
		expect(statSync(paths.egressProfileRoot).mode & 0o777).toBe(0o711);
		expect(statSync(paths.egressProfileBundle).mode & 0o777).toBe(0o640);
		expect(statSync(paths.egressRoot).mode & 0o777).toBe(0o711);
		expect(statSync(paths.egressAddon).mode & 0o777).toBe(0o640);
		expect(statSync(paths.egressTransparentEnv).mode & 0o777).toBe(0o640);
		expect(statSync(paths.egressCaDir).mode & 0o777).toBe(0o700);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(statSync(paths.egressProfileBundle).uid).toBe(0);
			expect(statSync(paths.egressProfileBundle).gid).toBe(10002);
			expect(statSync(paths.egressCaDir).uid).toBe(10002);
			expect(statSync(paths.egressCaDir).gid).toBe(10002);
			expect(statSync(paths.egressAddon).uid).toBe(0);
			expect(statSync(paths.egressAddon).gid).toBe(10002);
			expect(statSync(paths.egressTransparentEnv).uid).toBe(0);
			expect(statSync(paths.egressTransparentEnv).gid).toBe(10002);
		}
		expect(openclawUnit).not.toContain("\nExecStart=");
		expect(openclawUnit).not.toContain("\nWorkingDirectory=");
		expect(openclawEnv).not.toContain("CLAWDI_EGRESS_PROFILE_BUNDLE");
		expect(openclawEnv).not.toContain("CLAWDI_EGRESS_SECRET_FILE");
		expect(openclawEnv).not.toContain("HTTPS_PROXY=");
		expect(openclawEnv).not.toContain("OPENCLAW_PROXY_URL=");
		expect(openclawEnv).not.toContain("NODE_USE_ENV_PROXY=");
		expect(openclawEnv).toContain(
			`NODE_EXTRA_CA_CERTS="${join(run, "egress", "systemd", "ca.pem")}"`,
		);
		expect(openclawUnit).not.toContain("clawdi run -- openclaw");

		process.env.CLAWDI_EGRESS_UID = "10012";
		process.env.CLAWDI_EGRESS_GID = "10013";
		convergeRuntimeManifest(load, paths);
		const updatedSidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
		const updatedTransparentEgressEnv = readFileSync(paths.egressTransparentEnv, "utf-8");
		expect(systemdEnvDigest(updatedSidecarEnv)).not.toBe(initialSidecarRevision);
		expect(updatedTransparentEgressEnv).toContain('CLAWDI_EGRESS_UID="10012"');
		expect(updatedTransparentEgressEnv).toContain('CLAWDI_EGRESS_GID="10013"');
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(statSync(paths.egressCaDir).uid).toBe(10012);
			expect(statSync(paths.egressCaDir).gid).toBe(10013);
		}
	});

	it("keeps the previous live generation unchanged when runtime install fails", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const failingInstaller = join(root, "install-openclaw.sh");
		mkdirSync(home, { recursive: true });
		writeFileSync(failingInstaller, "#!/usr/bin/env bash\nexit 42\n");
		chmodSync(failingInstaller, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = failingInstaller;
		const paths = getRuntimePaths();
		const cachePath = paths.manifestLastGood;
		mkdirSync(dirname(cachePath), { recursive: true });
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		const previousManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_last_good_floor",
			environmentId: "env_last_good_floor",
			instanceId: "iid_last_good_floor",
			generation: 1,
			issuedAt: "2026-06-06T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: { openclaw: { enabled: false }, hermes: { enabled: false } },
			recovery: { cacheManifest: true, allowOfflineBoot: true },
		};
		writeFileSync(cachePath, JSON.stringify(previousManifest));
		const liveFiles = [
			join(paths.runConfigRoot, "openclaw.json"),
			join(paths.runConfigRoot, "stale-runtime.json"),
			join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
			join(paths.systemdUserRoot, "openclaw-gateway.service"),
		];
		for (const path of liveFiles) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `generation-1:${path.split("/").at(-1)}\n`);
		}
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T05:00:00.000Z",
				instanceId: previousManifest.instanceId,
				etag: testBundleEtag("manifest-generation-1"),
				sourceRevision: "a".repeat(64),
				generation: 1,
				contentIdentity: {
					sourcePath: "https://runtime.test/v1/runtime/manifest",
					sha256: "b".repeat(64),
				},
				activated: {},
				providerIds: [],
				projectedProviderIds: { openclaw: ["generation-1-provider"] },
			},
			paths,
		);
		const previousLiveSnapshot = Object.fromEntries(
			[...liveFiles, paths.appliedState].map((path) => [path, readFileSync(path, "utf-8")]),
		);
		const loaded: RuntimeManifestLoad = {
			manifest: {
				...previousManifest,
				generation: 2,
				runtimes: {
					openclaw: {
						enabled: true,
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: [],
						},
					},
					hermes: { enabled: false },
				},
			} as RuntimeManifest,
			source: "remote-datasource",
			sourcePath: "test://install-error",
			offline: false,
			secretValues: {},
		};

		const convergence = convergeRuntimeManifest(loaded, paths);

		expect(convergence.installErrors.join("\n")).toContain(
			`runtime openclaw installer failed or did not create ${join(home, ".local", "bin", "openclaw")}; see ${join(paths.statusRoot, "installer-logs", "openclaw.log")}`,
		);
		expect(convergence.outputs.manifestLastGood).toBeNull();
		expect(JSON.parse(readFileSync(cachePath, "utf-8")).generation).toBe(1);
		expect(convergence.outputs.systemdSystemUnits).toEqual([]);
		expect(convergence.outputs.systemdUserUnits).toEqual([]);
		for (const [path, content] of Object.entries(previousLiveSnapshot)) {
			expect(readFileSync(path, "utf-8")).toBe(content);
		}
	});

	it("updates the OpenClaw locale block without changing user-authored workspace content", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const soulPath = join(home, ".openclaw", "workspace", "SOUL.md");
		const userPath = join(workspace, "USER.md");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(dirname(soulPath), { recursive: true });
		seedOpenClawBinary(home);
		writeFileSync(soulPath, "User preface.\n\nUser epilogue.\n");
		writeFileSync(userPath, "User profile stays untouched.\n");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const paths = getRuntimePaths();
		const converge = (language: "en" | "fr", timezone: string) => {
			const load = hostedSingleProviderModeLoad(
				home,
				"openclaw",
				"unmanaged",
				language === "en" ? 1 : 2,
			);
			load.manifest.locale = { language, timezone };
			return convergeRuntimeManifest(load, paths);
		};

		converge("en", "UTC");
		const initialRevision = systemdEnvDigest(readSystemdEnvFile(paths, "openclaw-gateway"));

		converge("fr", "Europe/Paris");
		const soul = readFileSync(soulPath, "utf-8");
		expect(soul.startsWith("User preface.\n\nUser epilogue.\n")).toBe(true);
		expect(soul.match(/clawdi managed locale/g)).toHaveLength(2);
		expect(soul).toContain("`fr`");
		expect(soul).toContain("`Europe/Paris`");
		expect(readFileSync(userPath, "utf-8")).toBe("User profile stays untouched.\n");
		// The OpenClaw gateway watcher applies SOUL.md and agent defaults in place.
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "openclaw-gateway"))).toBe(initialRevision);
		converge("fr", "Europe/Paris");
		expect(readFileSync(soulPath, "utf-8")).toBe(soul);
	});

	it("projects Hermes locale into its managed SOUL block and timezone config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const hermesHome = join(home, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "SOUL.md"), "User Hermes identity.\n");
		writeFileSync(join(hermesHome, "config.yaml"), "custom_setting: keep\n");
		const hermesCommand = writeHermesVersionBinary(home, "0.20.1");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_locale_hermes",
			environmentId: "env_locale_hermes",
			instanceId: "iid_locale_hermes",
			generation: 1,
			issuedAt: "2026-07-11T00:00:00Z",
			locale: { language: "zh-TW", timezone: "Asia/Taipei" },
			workspaceRoot: join(home, "clawdi"),
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: {
				hermes: {
					enabled: true,
					run: { command: hermesCommand, args: ["gateway", "run"], env: {}, prependPath: [] },
				},
			},
			recovery: {},
		};
		const paths = getRuntimePaths();
		convergeRuntimeManifest(
			{
				manifest,
				source: "remote-datasource",
				sourcePath: "test://locale-hermes",
				offline: false,
				secretValues: {},
			},
			paths,
		);

		const soul = readFileSync(join(hermesHome, "SOUL.md"), "utf-8");
		expect(soul.startsWith("User Hermes identity.\n")).toBe(true);
		expect(soul).toContain("`zh-TW`");
		const config = readHermesConfigYaml(home);
		expect(config.custom_setting).toBe("keep");
		expect(config.timezone).toBe("Asia/Taipei");
	});

	it("rejects a desired generation below the durable applied generation", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const manifestPath = join(root, "runtime-reset.json");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
		const desiredPayload = hostedRuntimeWatchLocalePayload(home, 1);
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T05:00:00.000Z",
				instanceId: "iid_watch_locale",
				etag: testBundleEtag("generation-reset-previous"),
				sourceRevision: "a".repeat(64),
				generation: 42,
				contentIdentity: {
					sourcePath: "test://generation-reset-previous",
					sha256: "b".repeat(64),
				},
				activated: {},
				providerIds: [],
				projectedProviderIds: {},
			},
			paths,
		);
		writeFileSync(manifestPath, JSON.stringify(desiredPayload));

		const loaded = await loadCanonicalBundleFixture(manifestPath, paths);

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest rejection");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.rejectedGeneration).toBe(1);
		expect(loaded.activeGeneration).toBe(42);
		expect(loaded.errors).toContain("manifest generation 1 is older than applied generation 42");
	});

	it("rejects hosted manifests without cloudApiUrl instead of deriving it from the source URL", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_manifest_only",
							environmentId: "env_manifest_only",
							...hostedRequiredState(),
							instanceId: "iid_manifest_only",
							generation: 1,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime(),
							},
						},
						secretValues: {},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			expect("errors" in loaded).toBe(true);
			if (!("errors" in loaded)) throw new Error("expected manifest load failure");
			expect(loaded.mode).toBe("manifest-rejected");
			expect(loaded.errors.join("\n")).toContain("cloudApiUrl");
		} finally {
			restore();
		}
	});

	it("converges remote manifests and starts the observation daemon with liveSync agents=[]", async () => {
		setRuntimeApplyGeneration(4, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "auth-token";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
			join(root, "remote-provider-auth"),
			join(root, "remote-provider-auth", "calls.log"),
		);
		const mitmproxy = seedMitmproxyCache();
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_test",
							environmentId: "env_test",
							...hostedRequiredState(),
							instanceId: "iid_remote",
							generation: 4,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							egressEngine: mitmproxy,
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime({
									provider_ids: ["clawdi-managed-v2"],
									primary_model: {
										provider_id: "clawdi-managed-v2",
										model: "gpt-test",
									},
								}),
							},
							providers: {
								"clawdi-managed-v2": {
									kind: "openai-compatible",
									type: "custom_openai_compatible",
									baseUrl: "https://sub2api.test/v1",
									models: [{ id: "gpt-test" }],
									apiMode: "openai_chat",
									managed_by: "clawdi",
									runtimeEnvName: "CLAWDI_AI_API_KEY",
									apiKeySecretRef: "secret://tool.codex.apiKey",
								},
							},
						},
						secretValues: {
							"secret://tool.codex.apiKey": "sk-runtime",
						},
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			if (!("manifest" in loaded))
				throw new Error(`expected manifest load success: ${JSON.stringify(loaded)}`);
			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

			expect(convergence.mode).toBe("normal");
			expect(convergence.installErrors).toEqual([]);
			const paths = getRuntimePaths();
			expectEgressProfileBundleUsesSecretRef(
				convergence.outputs.egressProfileBundle,
				"secret://tool.codex.apiKey",
				"sk-runtime",
			);
			expectMitmSecretFileIsSidecarOnly(
				paths,
				convergence.outputs.egressSecretFile,
				"secret://tool.codex.apiKey",
				"sk-runtime",
			);
			expectExistingFileNotToContain(join(run, "secrets", "runtime-secrets.json"), "sk-runtime");
			const secretCache = readFileSync(getRuntimePaths().managedSecretCacheFile, "utf-8");
			expect(secretCache).toContain("secret://runtime/openclaw/gateway-token");
			expect(secretCache).not.toContain("sk-runtime");
			expect(convergence.outputs.processManager).toBe("systemd");
			expect(convergence.outputs.systemdSystemUnits).toEqual([
				join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
				join(paths.systemdSystemRoot, "clawdi-daemon.service"),
				join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"),
			]);
			expect(convergence.outputs.systemdUserUnits).toEqual([
				join(paths.systemdUserRoot, "openclaw-gateway.service"),
			]);
			const watchUnit = readSystemdSystemUnit(paths, "clawdi-runtime-watch");
			const watchEnv = readSystemdEnvFile(paths, "clawdi-runtime-watch");
			const daemonEnv = readSystemdEnvFile(paths, "clawdi-daemon");
			expect(watchUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "watch"`);
			expect(daemonEnv).toContain('CLAWDI_ENVIRONMENT_ID="env_test"');
			expect(daemonEnv).toContain('CLAWDI_SERVE_MODE="container"');
			expect(daemonEnv).toContain('CLAWDI_AUTH_TOKEN_ORIGIN="https://cloud-api.test"');
			expect(watchUnit).not.toContain("sk-runtime");
			expect(watchEnv).not.toContain("sk-runtime");
			expect(readFileSync(getRuntimePaths().manifestLastGood, "utf-8")).not.toContain("sk-runtime");
			const providerHealth = (await readHostedRuntimeObserved(paths))?.providers;
			expect(providerHealth?.["clawdi-managed-v2"]).toEqual({
				status: "ok",
				configured: true,
				kind: "openai-compatible",
				baseUrl: "https://sub2api.test/v1",
				model: null,
				models: [{ id: "gpt-test" }],
				apiKeySecretRef: "secret://tool.codex.apiKey",
				secretAvailable: true,
				reasons: [],
			});
			expect(JSON.stringify(providerHealth)).not.toContain("sk-runtime");
		} finally {
			restore();
		}
	});

	it("registers live-sync environments and starts one hosted daemon", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_AUTH_TOKEN = "runtime-auth-token";
		const retiredEnvironment = join(home, ".clawdi", "environments", "openclaw.json");
		const retiredEnvironmentContent = `${JSON.stringify({
			id: "env-retired",
			agentType: "openclaw",
			managedBy: "clawdi runtime init",
		})}\n`;
		mkdirSync(dirname(retiredEnvironment), { recursive: true });
		writeFileSync(retiredEnvironment, retiredEnvironmentContent);
		setRuntimeApplyGeneration(9, {
			...CANONICAL_TEST_CONTEXT,
			bootstrapBearer: "runtime-auth-token",
			manifestSourceUrl: "https://runtime-source.test/v1/runtime/manifest",
		});
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					hostedRuntimeBundleResponse({
						manifest: {
							schemaVersion: "clawdi.hosted-runtime.manifest.v1",
							runtime: "openclaw",
							deploymentId: "dep_sync",
							environmentId: "env_sync",
							...hostedRequiredState(),
							instanceId: "iid_sync",
							generation: 9,
							issuedAt: "2026-06-06T00:00:00Z",
							locale: TEST_HOSTED_LOCALE,
							system: hostedSystemFixture(home),
							controlPlane: {
								cloudApiUrl: "https://cloud-api.test",
							},
							clawdiCli: {
								source: "npm:clawdi",
								packageSpec: TEST_RUNNING_CLI_SPEC,
								registry: "https://registry.npmjs.org",
							},
							runtimes: {
								openclaw: hostedOpenClawRuntime(),
							},
							liveSync: {
								enabled: true,
								agents: [
									{ agentType: "openclaw", environmentId: "env-openclaw" },
									{ agentType: "codex", environmentId: "env-codex" },
								],
							},
						},
						secretValues: { "secret://clawdi/auth-token": "runtime-auth-token" },
					}),
			},
		]);

		try {
			const loaded = await loadRuntimeManifest(getRuntimePaths());
			if (!("manifest" in loaded)) throw new Error("expected manifest load success");
			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
			const paths = getRuntimePaths();
			const systemUnitNames = convergence.outputs.systemdSystemUnits.map((path) =>
				path.split("/").at(-1),
			);
			const watchUnit = readSystemdSystemUnit(paths, "clawdi-runtime-watch");
			const watchEnv = readSystemdEnvFile(paths, "clawdi-runtime-watch");
			const daemonUnit = readSystemdSystemUnit(paths, "clawdi-daemon");
			const daemonEnv = readSystemdEnvFile(paths, "clawdi-daemon");
			const openclawEnv = JSON.parse(
				readFileSync(join(paths.localEnvironments, "openclaw.json"), "utf-8"),
			);
			const codexEnv = JSON.parse(
				readFileSync(join(paths.localEnvironments, "codex.json"), "utf-8"),
			);

			expect(convergence.outputs.liveSyncEnvironments.sort()).toEqual([
				join(paths.localEnvironments, "codex.json"),
				join(paths.localEnvironments, "openclaw.json"),
			]);
			expect(readFileSync(retiredEnvironment, "utf-8")).toBe(retiredEnvironmentContent);
			expect(convergence.outputs.daemonAuthTokenFile).toBe(join(run, "secrets", "auth-token"));
			expect(readFileSync(join(run, "secrets", "auth-token"), "utf-8")).toBe(
				"runtime-auth-token\n",
			);
			expect(openclawEnv.id).toBe("env-openclaw");
			expect(codexEnv.id).toBe("env-codex");
			expect(systemUnitNames).toContain("clawdi-runtime-watch.service");
			expect(systemUnitNames).toContain("clawdi-daemon.service");
			expect(watchUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "watch"`);
			expect(watchEnv).not.toContain("CLAWDI_RUNTIME_MANIFEST_URL");
			expect(watchEnv).not.toContain("runtime-auth-token");
			expect(daemonUnit).toContain(
				`ExecStart="${paths.cliManagedBin}" "daemon" "run" "--auth-token-file" "${join(
					run,
					"secrets",
					"auth-token",
				)}"`,
			);
			expect(daemonUnit).not.toContain("ExecStart=/bin/sh -lc");
			expect(daemonEnv).toContain('CLAWDI_SERVE_MODE="container"');
			const daemonStateDir = join(state, "daemon");
			expect(daemonEnv).toContain(`CLAWDI_STATE_DIR="${daemonStateDir}"`);
			process.env.CLAWDI_STATE_DIR = daemonStateDir;
			const controlTokenPath = getDaemonControlTokenPath();
			expect(controlTokenPath).toBe(join(state, "daemon", "control", "control-token"));
			expect(controlTokenPath.startsWith(home)).toBe(false);
			delete process.env.CLAWDI_STATE_DIR;
			expect(daemonEnv).toContain('CLAWDI_MANAGED_CONTENT_DIGEST="');
			expect(daemonEnv).toContain("https://cloud-api.test");
			expect(watchEnv).not.toContain("CLAWDI_RUNTIME_AUTH_ENV");
			expect(watchEnv).toContain('CLAWDI_AUTH_TOKEN=""');
			expect(watchUnit).not.toContain("runtime-auth-token");
			expect(watchEnv).not.toContain("runtime-auth-token");
			expect(daemonUnit).not.toContain("runtime-auth-token");
			expect(daemonEnv).not.toContain("runtime-auth-token");
		} finally {
			restore();
		}
	});

	it("skips a runtime provider egress profile without disturbing the Codex tool profile", async () => {
		setRuntimeApplyGeneration(1, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const manifestPath = join(root, "hosted-no-provider-secret.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "openclaw",
					deploymentId: "dep_no_secret_ref",
					environmentId: "env_no_secret_ref",
					...hostedRequiredState(),
					instanceId: "iid_no_secret_ref",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime(),
					},
					providers: {
						default: {
							kind: "openai-compatible",
							type: "custom_openai_compatible",
							baseUrl: "https://sub2api.test/v1",
						},
					},
				},
				secretValues: TEST_HOSTED_CODEX_SECRET_VALUES,
			}),
		);

		const loaded = await loadCanonicalBundleFixture(manifestPath);

		expect("manifest" in loaded).toBe(true);
		if (!("manifest" in loaded)) throw new Error("expected manifest load success");
		const profiles = loaded.manifest.egressProfiles?.profiles ?? [];
		const providerProfiles = profiles.filter((profile) => profile.kind === "provider");
		expect(providerProfiles).toHaveLength(1);
		expect(JSON.stringify(providerProfiles[0])).toContain(TEST_HOSTED_CODEX_SECRET_REF);
		expect(JSON.stringify(providerProfiles[0])).not.toContain("secret://provider.default.apiKey");
	});

	it("rejects invalid explicit hosted egress profiles instead of falling back", async () => {
		const home = join(root, "home", "clawdi");
		const manifestPath = join(root, "hosted-bad-egress.json");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "hermes",
					deploymentId: "dep_bad_mitm",
					environmentId: "env_bad_mitm",
					...hostedRequiredState(),
					instanceId: "iid_bad_mitm",
					generation: 1,
					issuedAt: "2026-06-06T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						hermes: hostedHermesRuntime(),
					},
					egressProfiles: {
						profiles: [
							{
								id: "bad-prefix",
								enabled: true,
								kind: "http",
								match: { scheme: "https", host: "example.com", pathPrefix: "api/" },
								rewrite: { upstreamBaseUrl: "https://router.test" },
							},
						],
					},
				},
				secretValues: {},
			}),
		);

		const loaded = await loadCanonicalBundleFixture(manifestPath);

		expect("errors" in loaded).toBe(true);
		if (!("errors" in loaded)) throw new Error("expected manifest load failure");
		expect(loaded.mode).toBe("manifest-rejected");
		expect(loaded.errors.join("\n")).toContain("pathPrefix must start with /");
	});
});

it.skipIf(!process.env.CLAWDI_VAULT_FIXTURE_URL)(
	"runtime Vault delivery over PostgreSQL HTTP with SSE and missed-event fallback",
	async () => {
		const apiUrl = process.env.CLAWDI_VAULT_FIXTURE_URL;
		const agentId = process.env.CLAWDI_VAULT_FIXTURE_AGENT;
		const vaultId = process.env.CLAWDI_VAULT_FIXTURE_VAULT;
		const runtimeToken = process.env.CLAWDI_VAULT_FIXTURE_TOKEN;
		const ownerToken = process.env.CLAWDI_VAULT_FIXTURE_OWNER;
		if (!apiUrl || !agentId || !vaultId || !runtimeToken || !ownerToken)
			throw new Error("Missing isolated Vault fixture");
		installSuccessfulSystemctlFixture();
		const home = join(root, "home", "clawdi");
		// Bind the real fixture endpoint before committing both snapshot and applied SHA.
		const paths = seedRuntimeWatchLocaleBaseline(home, join(root, "platform"), join(root, "run"), {
			apiUrl,
			agentId,
		});
		const committed = loadCommittedRuntimeManifest(paths);
		if (!("manifest" in committed))
			throw new Error("Vault fixture has no committed runtime snapshot");
		expect(committed.manifest).toMatchObject({ environmentId: agentId, controlPlane: { apiUrl } });
		expect(readRuntimeAppliedState(paths)?.contentIdentity.sha256).toBe(
			runtimeAppliedContentIdentity(committed).sha256,
		);
		writeFileSync(join(root, "run", "secrets", "auth-token"), runtimeToken);
		process.env.CLAWDI_AUTH_TOKEN = runtimeToken;
		const workspace = resolveHostedOpenClawWorkspace(home);
		const indexPath = join(workspace, ".clawdi", "vaults", "index.json");
		const originalFetch = globalThis.fetch;
		const originalLog = console.log;
		const statuses: string[] = [];
		let counts = { metadata: 0, material: 0, manifests: 0, sse: 0 };
		let sseConnected = Promise.withResolvers<void>();
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			async (...args: Parameters<typeof fetch>) => {
				const input = args[0];
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (url.pathname === "/v1/runtime/manifest") {
					counts.manifests++;
					return new Response(null, { status: 304 });
				}
				if (url.pathname === "/v1/runtime/vaults") counts.metadata++;
				if (url.pathname === "/v1/runtime/vaults/material") counts.material++;
				const response = await originalFetch(...args);
				if (url.pathname === "/v1/sync/events") {
					counts.sse++;
					if (response.status === 200) sseConnected.resolve();
				}
				return response;
			},
		);
		console.log = (line?: unknown) => {
			const text = String(line);
			try {
				statuses.push(JSON.parse(text).status);
			} catch {
				originalLog(text);
			}
		};
		async function waitFor(check: () => boolean) {
			const deadline = Date.now() + 8000;
			while (!check()) {
				if (Date.now() > deadline) throw new Error("Vault fixture delivery timeout");
				await new Promise((resolveWait) => setTimeout(resolveWait, 10));
			}
		}
		const secretFile = () => {
			if (!existsSync(indexPath)) return null;
			const index = JSON.parse(readFileSync(indexPath, "utf8"));
			const section = index.vaults[0]?.sections[0];
			return section ? join(workspace, ".clawdi", "vaults", section.file) : null;
		};
		const activeStarts = () =>
			existsSync(join(root, "systemctl-success.log"))
				? readFileSync(join(root, "systemctl-success.log"), "utf8")
						.split("\n")
						.filter((line) => /\b(start|restart|try-restart)\b/.test(line))
				: [];
		try {
			for (const notifications of [true, false]) {
				const abort = new AbortController();
				const deadline = setTimeout(() => abort.abort(), 12000);
				const beforeStarts = activeStarts();
				counts = { metadata: 0, material: 0, manifests: 0, sse: 0 };
				sseConnected = Promise.withResolvers<void>();
				const initial = statuses.length;
				const watcher = runtimeWatch({
					json: true,
					intervalMs: notifications ? 15000 : 200,
					selfHealMs: 300000,
					notifications,
					abort: abort.signal,
				});
				try {
					await waitFor(() => statuses.length > initial && secretFile() !== null);
					if (notifications)
						await Promise.race([
							sseConnected.promise,
							new Promise((_, reject) =>
								setTimeout(() => reject(new Error("SSE fixture timeout")), 5000),
							),
						]);
					const file = secretFile();
					if (!file) throw new Error("Missing initial Vault file");
					const initialMtime = statSync(file, { bigint: true }).mtimeNs;
					const value = notifications ? "sse-rotated" : "fallback-rotated";
					const started = performance.now();
					const saved = await originalFetch(`${apiUrl}/v1/vault/live/items?vault_id=${vaultId}`, {
						method: "PUT",
						headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
						body: JSON.stringify({ section: "", fields: { TOKEN: value } }),
					});
					expect(saved.status).toBe(200);
					await waitFor(() => JSON.parse(readFileSync(file, "utf8")).TOKEN === value);
					const latency = performance.now() - started;
					expect(statSync(file, { bigint: true }).mtimeNs).not.toBe(initialMtime);
					expect(activeStarts()).toEqual(beforeStarts);
					expect(statuses.every((status) => status === "not_modified")).toBe(true);
					const after = statSync(file, { bigint: true }).mtimeNs;
					if (!notifications) {
						const metadataCount = counts.metadata;
						await waitFor(() => counts.metadata > metadataCount);
						expect(statSync(file, { bigint: true }).mtimeNs).toBe(after);
					}
					originalLog(
						JSON.stringify({
							fixture: "PostgreSQL HTTP runtime watch",
							notifications,
							fallbackMs: notifications ? 15000 : 200,
							saveToFileMs: Math.round(latency),
							requests: counts,
						}),
					);
				} finally {
					abort.abort();
					clearTimeout(deadline);
					await watcher;
				}
			}
		} finally {
			fetchSpy.mockRestore();
			console.log = originalLog;
		}
	},
	30000,
);
