import { afterEach, describe, expect, test } from "bun:test";
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
import { dirname, join } from "node:path";
import {
	convergeRuntimeManifest,
	hostedAiProviderCatalog,
	type RuntimeManifest,
	runtimeProgramRevision,
	runtimeSecretValue,
	runtimeSidecarProgramRevision,
} from "./manifest";
import {
	hostedRuntimeManifestSchema,
	OFFICIAL_INSTALL_ARGS,
	OFFICIAL_INSTALL_URLS,
} from "./manifest-contract";
import {
	hostedManifestToRuntimeManifest,
	normalizeManifestPayload,
	type RuntimeManifestLoad,
} from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { type RuntimeRunSettings, runtimeRunConfigPath } from "./run-config";

const originalEnv = { ...process.env };
const tempRoots: string[] = [];
const TEST_HOSTED_LOCALE = { language: "en" as const, timezone: "UTC" };
const TEST_HOSTED_MINIMUM_CLI_VERSION = "0.12.10-beta.51";
const TEST_HOSTED_HOME = "/home/clawdi";
const TEST_HOSTED_WORKSPACE = "/home/clawdi/clawdi";

function hostedSystemFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		user: "clawdi",
		home: TEST_HOSTED_HOME,
		workspace: TEST_HOSTED_WORKSPACE,
		persistentPaths: [TEST_HOSTED_HOME, TEST_HOSTED_WORKSPACE],
		...overrides,
	};
}

function tempRuntimePaths(): RuntimePaths {
	const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-reconcile-test-"));
	tempRoots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "run", "systemd", "system");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	process.env.CLAWDI_HOME = join(root, "clawdi-home");
	process.env.CLAWDI_AUTH_TOKEN = "test-token";
	process.env.CLAWDI_RUNTIME_AUTH_ENV = "CLAWDI_AUTH_TOKEN";
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
	return getRuntimePaths({ mode: "hosted" });
}

function runSettings(command: string, args: string[]): RuntimeRunSettings {
	return { command, args, env: {}, prependPath: [] };
}

function manifestLoad(
	manifest: RuntimeManifest,
	sourcePath: string,
	secretValues?: Record<string, string>,
): RuntimeManifestLoad {
	return {
		manifest,
		source: "fixture-file",
		sourcePath,
		offline: false,
		secretValues,
	};
}

function baseManifest(
	paths: RuntimePaths,
	runtimes: RuntimeManifest["runtimes"],
	overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
	return {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_reconcile",
		environmentId: "env_reconcile",
		instanceId: "hri_reconcile",
		generation: 1,
		issuedAt: "2026-07-01T00:00:00.000Z",
		workspaceRoot: join(paths.userHome, "clawdi"),
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		runtimes,
		recovery: {},
		...overrides,
	};
}

function hostedManifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "clawdi.hosted-runtime.manifest.v1",
		minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
		runtime: "openclaw",
		deploymentId: "hdep_locale",
		environmentId: "env_locale",
		instanceId: "hri_locale",
		generation: 1,
		issuedAt: "2026-07-11T00:00:00.000Z",
		locale: TEST_HOSTED_LOCALE,
		system: hostedSystemFixture(),
		controlPlane: { cloudApiUrl: "https://cloud-api.example.test" },
		clawdiCli: {
			source: "npm:clawdi",
			packageSpec: "clawdi@agent-v2",
			registry: "https://registry.npmjs.org",
		},
		providers: {
			default: {
				kind: "openai-compatible",
				status: "error",
				error: { code: "provider_not_found", message: "fixture provider unavailable" },
			},
		},
		liveSync: { enabled: false, agents: [] },
		recovery: { cacheManifest: true, allowOfflineBoot: true },
		runtimes: {
			openclaw: {
				enabled: true,
				provider_ids: ["default"],
				primary_model: { provider_id: "default", model: "gpt-test" },
				paths: { home: TEST_HOSTED_HOME, workspace: TEST_HOSTED_WORKSPACE },
			},
		},
		...overrides,
	};
}

function hostedRuntimeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const paths =
		typeof overrides.paths === "object" &&
		overrides.paths !== null &&
		!Array.isArray(overrides.paths)
			? (overrides.paths as Record<string, unknown>)
			: {};
	return {
		enabled: true,
		provider_ids: ["default"],
		primary_model: { provider_id: "default", model: "gpt-test" },
		...overrides,
		paths: { home: TEST_HOSTED_HOME, workspace: TEST_HOSTED_WORKSPACE, ...paths },
	};
}

function writeFakeGatewayCli(input: {
	path: string;
	runtime: "openclaw" | "hermes";
	unitPath: string;
	failInstall?: boolean;
}): void {
	mkdirSync(dirname(input.path), { recursive: true });
	writeFileSync(
		input.path,
		`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "gateway install --force --json"|"gateway install --force"|"gateway install")
    ${
			input.failInstall
				? "exit 41"
				: `mkdir -p '${dirname(input.unitPath)}'
    cat > '${input.unitPath}' <<'EOF'
[Unit]
Description=Official gateway

[Service]
ExecStart=official gateway run
EOF`
		}
    ;;
  *)
    printf 'unexpected ${input.runtime} command: %s\\n' "$*" >&2
    exit 64
    ;;
esac
`,
	);
	chmodSync(input.path, 0o700);
}

afterEach(() => {
	process.env = { ...originalEnv };
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime manifest reconciliation invariants", () => {
	test("accepts and preserves the exact hosted locale contract", () => {
		const parsed = hostedRuntimeManifestSchema.parse(
			hostedManifestFixture({ locale: { language: "zh-CN", timezone: "Asia/Shanghai" } }),
		);
		expect(parsed.locale).toEqual({ language: "zh-CN", timezone: "Asia/Shanghai" });
		expect(hostedManifestToRuntimeManifest(parsed).locale).toEqual(parsed.locale);
	});

	test.each([
		["missing locale", undefined],
		["unknown locale key", { language: "en", timezone: "UTC", personality: "warm" }],
		["malformed language", { language: "zh-cn", timezone: "UTC" }],
		["unsupported language", { language: "en-US", timezone: "UTC" }],
		["invalid timezone", { language: "en", timezone: "Mars/Olympus" }],
	])("rejects hosted manifests with %s", (_name, locale) => {
		expect(hostedRuntimeManifestSchema.safeParse(hostedManifestFixture({ locale })).success).toBe(
			false,
		);
	});

	test.each([
		["missing providers", undefined],
		["missing selected provider", {}],
		[
			"unselected provider",
			{
				default: { kind: "openai-compatible" },
				extra: { kind: "openai-compatible" },
			},
		],
	])("rejects hosted manifests with %s", (_name, providers) => {
		expect(
			hostedRuntimeManifestSchema.safeParse(hostedManifestFixture({ providers })).success,
		).toBe(false);
	});

	test.each([
		["enabled without agents", { enabled: true, agents: [] }],
		[
			"disabled with agents",
			{ enabled: false, agents: [{ agentType: "openclaw", environmentId: "env-live" }] },
		],
		[
			"duplicate agents",
			{
				enabled: true,
				agents: [
					{ agentType: "openclaw", environmentId: "env-live" },
					{ agentType: "openclaw", environmentId: "env-live" },
				],
			},
		],
		[
			"environment id with surrounding whitespace",
			{ enabled: true, agents: [{ agentType: "openclaw", environmentId: " env-live " }] },
		],
		[
			"unsupported agent type",
			{ enabled: true, agents: [{ agentType: "custom-runtime", environmentId: "env-live" }] },
		],
		[
			"overlong environment id",
			{ enabled: true, agents: [{ agentType: "openclaw", environmentId: "e".repeat(201) }] },
		],
	])("rejects hosted live sync with %s", (_name, liveSync) => {
		expect(hostedRuntimeManifestSchema.safeParse(hostedManifestFixture({ liveSync })).success).toBe(
			false,
		);
	});

	test.each([
		["language", "en"],
		["timezone", "UTC"],
		["personality", "warm"],
	])("rejects the top-level %s compatibility field", (field, value) => {
		expect(
			hostedRuntimeManifestSchema.safeParse(hostedManifestFixture({ [field]: value })).success,
		).toBe(false);
	});

	test.each([
		["providerIds", hostedRuntimeFixture({ providerIds: ["default"] })],
		[
			"primaryModel",
			hostedRuntimeFixture({
				primaryModel: { provider_id: "default", model: "gpt-test" },
			}),
		],
		[
			"primary_model.providerId",
			hostedRuntimeFixture({
				primary_model: { providerId: "default", model: "gpt-test" },
			}),
		],
		["string primary_model", hostedRuntimeFixture({ primary_model: "gpt-test" })],
		[
			"paths.stateDir",
			hostedRuntimeFixture({
				paths: { home: "/home/clawdi", workspace: "/workspace", stateDir: "/state" },
			}),
		],
	])("rejects noncanonical hosted runtime field %s", (_name, runtime) => {
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({ runtimes: { openclaw: runtime } }),
			).success,
		).toBe(false);
	});

	test("copies canonical runtime provider bindings without backfill", () => {
		const canonical = hostedRuntimeManifestSchema.parse(
			hostedManifestFixture({
				runtimes: {
					openclaw: hostedRuntimeFixture({
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-test" },
					}),
				},
			}),
		);
		expect(hostedManifestToRuntimeManifest(canonical).runtimes.openclaw).toMatchObject({
			provider_ids: ["default"],
			primary_model: { provider_id: "default", model: "gpt-test" },
		});
	});

	test.each([
		["missing provider_ids", { provider_ids: undefined }],
		["empty provider_ids", { provider_ids: [] }],
		["duplicate provider_ids", { provider_ids: ["default", "default"] }],
		["missing primary_model", { primary_model: undefined }],
		[
			"primary model provider outside provider_ids",
			{
				provider_ids: ["default"],
				primary_model: { provider_id: "other", model: "gpt-test" },
			},
		],
	])("rejects hosted runtime with %s", (_name, overrides) => {
		const runtime = hostedRuntimeFixture(overrides);
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({ runtimes: { openclaw: runtime } }),
			).success,
		).toBe(false);
	});

	test.each([
		"system",
		"system.user",
		"system.home",
		"system.workspace",
		"system.persistentPaths",
		"runtime.paths",
		"runtime.paths.home",
		"runtime.paths.workspace",
	])("rejects hosted manifests with missing %s", (field) => {
		const manifest = structuredClone(hostedManifestFixture()) as Record<string, unknown>;
		const system = manifest.system as Record<string, unknown>;
		const runtimes = manifest.runtimes as Record<string, Record<string, unknown>>;
		const runtime = runtimes.openclaw;
		const paths = runtime.paths as Record<string, unknown>;
		if (field === "system") delete manifest.system;
		if (field === "system.user") delete system.user;
		if (field === "system.home") delete system.home;
		if (field === "system.workspace") delete system.workspace;
		if (field === "system.persistentPaths") delete system.persistentPaths;
		if (field === "runtime.paths") delete runtime.paths;
		if (field === "runtime.paths.home") delete paths.home;
		if (field === "runtime.paths.workspace") delete paths.workspace;

		expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(false);
	});

	test.each([
		["base_url", { base_url: "https://provider.example.test/v1" }],
		["api_mode", { api_mode: "openai_chat" }],
		["runtime_env_name", { runtime_env_name: "OPENAI_API_KEY" }],
		["api_key_secret_ref", { api_key_secret_ref: "provider.default.apiKey" }],
	])("rejects noncanonical hosted provider field %s", (_name, provider) => {
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({ providers: { default: provider } }),
			).success,
		).toBe(false);
	});

	test.each([
		"not-an-origin",
		"ftp://app-v2.example.test",
		"https://app-v2.example.test/path",
		"https://user@app-v2.example.test",
	])("rejects invalid OpenClaw Control UI origin %s", (origin) => {
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({
					system: hostedSystemFixture({
						openclawControlUiAllowedOrigins: [origin],
					}),
				}),
			).success,
		).toBe(false);
	});

	test("preserves canonical OpenClaw Control UI origins through gateway projection", () => {
		const paths = tempRuntimePaths();
		const workspace = join(paths.userHome, "clawdi");
		const openclawBin = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const patchPath = join(paths.serviceStateRoot, "openclaw-gateway-patch.json");
		const allowedOrigins = ["https://app-v2-18789.k3s.example.test"];
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeFileSync(
			openclawBin,
			[
				"#!/bin/sh",
				'if [ "$1 $2 $3" = "config patch --stdin" ]; then',
				`  cat > '${patchPath}'`,
				"  exit 0",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		chmodSync(openclawBin, 0o700);

		const hosted = hostedRuntimeManifestSchema.parse(
			hostedManifestFixture({
				system: hostedSystemFixture({
					home: paths.userHome,
					workspace,
					persistentPaths: [paths.userHome, workspace],
					openclawControlUiAllowedOrigins: allowedOrigins,
				}),
				runtimes: {
					openclaw: {
						enabled: true,
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-test" },
						install: { source: "official" },
						paths: { home: paths.userHome, workspace },
					},
				},
			}),
		);
		const normalized = hostedManifestToRuntimeManifest(hosted);
		expect(normalized.projection?.system).toEqual(hosted.system);

		const result = convergeRuntimeManifest(
			manifestLoad(normalized, "inline-hosted-control-ui-origins"),
			paths,
		);

		expect(result.installErrors).toEqual([]);
		expect(JSON.parse(readFileSync(patchPath, "utf8"))).toMatchObject({
			gateway: {
				controlUi: {
					allowedOrigins,
					dangerouslyDisableDeviceAuth: true,
				},
			},
		});
	});

	test("rejects hosted manifests without an explicit CLI package policy", () => {
		expect(() =>
			normalizeManifestPayload({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
					runtime: "openclaw",
					deploymentId: "hdep_missing_cli_policy",
					environmentId: "env_missing_cli_policy",
					instanceId: "hri_missing_cli_policy",
					generation: 1,
					issuedAt: "2026-07-11T00:00:00.000Z",
					locale: TEST_HOSTED_LOCALE,
					controlPlane: { cloudApiUrl: "https://cloud-api.example.test" },
					runtimes: { openclaw: { enabled: true } },
				},
				secretValues: {},
			}),
		).toThrow(/clawdiCli/);
	});

	test.each([
		["missing environmentId", {}],
		["appId fallback", { appId: "app_legacy_identity" }],
	])("rejects hosted manifests with %s", (_name, identity) => {
		const manifest = hostedManifestFixture(identity);
		delete manifest.environmentId;
		expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(false);
	});

	test("uses only the hosted environmentId as the runtime environment identity", () => {
		const parsed = hostedRuntimeManifestSchema.parse(
			hostedManifestFixture({
				deploymentId: "hdep_distinct_identity",
				environmentId: "env_canonical_identity",
			}),
		);

		expect(hostedManifestToRuntimeManifest(parsed).environmentId).toBe("env_canonical_identity");
	});

	test("rejects hosted manifests without a minimum CLI protocol floor", () => {
		const manifest = hostedManifestFixture();
		delete manifest.minimumCliVersion;
		expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(false);
	});

	test.each([
		["missing cloudApiUrl", {}],
		[
			"manifestUrl",
			{
				cloudApiUrl: "https://cloud-api.example.test",
				manifestUrl: "https://cloud-api.example.test/v1/runtime/manifest",
			},
		],
		[
			"apiUrl",
			{
				cloudApiUrl: "https://cloud-api.example.test",
				apiUrl: "https://cloud-api.example.test",
			},
		],
		["unknown key", { cloudApiUrl: "https://cloud-api.example.test", unknown: true }],
	])("rejects hosted controlPlane with %s", (_name, controlPlane) => {
		expect(
			hostedRuntimeManifestSchema.safeParse(hostedManifestFixture({ controlPlane })).success,
		).toBe(false);
	});

	test.each([
		{
			name: "wrong source",
			clawdiCli: {
				source: "npm:other",
				packageSpec: "clawdi@agent-v2",
				registry: "https://registry.npmjs.org",
			},
		},
		{
			name: "missing registry",
			clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@agent-v2" },
		},
		{
			name: "non-official registry",
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@agent-v2",
				registry: "https://registry.example.test",
			},
		},
		{
			name: "dead managed flags",
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@agent-v2",
				registry: "https://registry.npmjs.org",
				managedConfig: true,
				userEditableConfig: false,
			},
		},
	])("rejects hosted CLI policy with $name", ({ clawdiCli }) => {
		expect(() =>
			normalizeManifestPayload({
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
					runtime: "openclaw",
					deploymentId: "hdep_invalid_cli_policy",
					environmentId: "env_invalid_cli_policy",
					instanceId: "hri_invalid_cli_policy",
					generation: 1,
					issuedAt: "2026-07-11T00:00:00.000Z",
					locale: TEST_HOSTED_LOCALE,
					controlPlane: { cloudApiUrl: "https://cloud-api.example.test" },
					clawdiCli,
					runtimes: { openclaw: { enabled: true } },
				},
				secretValues: {},
			}),
		).toThrow();
	});

	test.each([
		"clawdi@agent-v2",
		"clawdi@0.12.10-beta.51",
		"/usr/local/share/clawdi/bootstrap/clawdi-0.12.10-beta.51.tgz",
	])("accepts hosted CLI package spec %s", (packageSpec) => {
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec,
						registry: "https://registry.npmjs.org",
					},
				}),
			).success,
		).toBe(true);
	});

	test.each([
		"clawdi@latest",
		"clawdi@beta",
		"clawdi",
		"clawdi@candidate",
		"./clawdi.tgz",
		"/tmp/clawdi.tgz",
		"/usr/local/share/clawdi/bootstrap/../clawdi.tgz",
		"/usr/local/share/clawdi/bootstrap/nested/clawdi.tgz",
		"/usr/local/share/clawdi/bootstrap/clawdi..tgz",
	])("rejects hosted CLI package spec %s", (packageSpec) => {
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec,
						registry: "https://registry.npmjs.org",
					},
				}),
			).success,
		).toBe(false);
	});

	test("normalizes hosted manifest responses into runtime desired state without embedding secrets", () => {
		const hostedResponse = {
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
				runtime: "openclaw",
				deploymentId: "hdep_normalize",
				environmentId: "env_normalize",
				instanceId: "hri_normalize",
				generation: 7,
				issuedAt: "2026-07-01T00:00:00.000Z",
				locale: TEST_HOSTED_LOCALE,
				system: hostedSystemFixture({
					home: "/home/clawdi-test",
					workspace: "/workspace/clawdi",
					persistentPaths: ["/home/clawdi-test", "/workspace/clawdi"],
				}),
				controlPlane: {
					cloudApiUrl: "https://cloud-api.example.test",
				},
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: "clawdi@agent-v2",
					registry: "https://registry.npmjs.org",
				},
				runtimes: {
					openclaw: {
						enabled: true,
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-test" },
						install: { source: "official", channel: "stable" },
						run: {
							command: "openclaw",
							args: [
								"gateway",
								"run",
								"--allow-unconfigured",
								"--auth",
								"token",
								"--bind",
								"lan",
								"--force",
							],
							env: { OPENCLAW_TEST: "1" },
							secretEnv: {
								OPENCLAW_GATEWAY_TOKEN: "env://OPENCLAW_GATEWAY_TOKEN",
							},
							prependPath: [],
						},
						paths: { home: "/home/clawdi-test", workspace: "/workspace/openclaw" },
					},
				},
				bridge: { surfaces: [] },
				providers: {
					default: {
						kind: "openai-compatible",
						type: "custom_openai_compatible",
						baseUrl: "https://api.example.test/v1",
						model: "gpt-test",
						apiMode: "openai_chat",
						apiKeySecretRef: "secret://providers/default/api-key",
					},
				},
				liveSync: {
					enabled: true,
					agents: [{ agentType: "openclaw", environmentId: "env_normalize" }],
				},
				egressProfiles: {
					profiles: [
						{
							id: "api-proxy",
							enabled: true,
							kind: "http",
							match: {
								scheme: "https",
								host: "api.example.test",
								pathPrefix: "/v1",
								headers: {},
								query: {},
							},
							rewrite: {
								upstreamBaseUrl: "https://upstream.example.test/v1",
								preservePath: true,
								setHeaders: {
									authorization: {
										type: "secretRef",
										secretRef: "secret://providers/default/api-key",
										prefix: "Bearer ",
									},
								},
							},
							logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
							priority: 120,
						},
					],
				},
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			},
			secretValues: {
				"providers/default/api-key": "sk-normalized",
			},
		};

		const normalized = normalizeManifestPayload(hostedResponse);
		const hostedManifest = hostedRuntimeManifestSchema.parse(hostedResponse.manifest);
		expect(normalized.manifest).toEqual(hostedManifestToRuntimeManifest(hostedManifest));
		expect(normalized.manifest.schemaVersion).toBe("clawdi.runtimeDesiredState.v1");
		expect(normalized.manifest.runtime).toBe("openclaw");
		expect(Object.keys(normalized.manifest.runtimes)).toEqual(["openclaw"]);
		expect(normalized.manifest.runtimes.openclaw.enabled).toBe(true);
		expect(normalized.manifest.runtimes.openclaw.updateChannel).toBe("stable");
		expect(normalized.manifest.runtimes.openclaw.install?.url).toBe(OFFICIAL_INSTALL_URLS.openclaw);
		expect(normalized.manifest.runtimes.openclaw.install?.args).toEqual(
			OFFICIAL_INSTALL_ARGS.openclaw,
		);
		expect(normalized.manifest.runtimes.openclaw.run?.args).toEqual([
			"gateway",
			"run",
			"--allow-unconfigured",
			"--auth",
			"token",
			"--bind",
			"lan",
			"--force",
		]);
		expect(normalized.manifest.runtimes.openclaw.run?.secretEnv).toEqual({
			OPENCLAW_GATEWAY_TOKEN: "env://OPENCLAW_GATEWAY_TOKEN",
		});
		expect(normalized.manifest.bridge?.surfaces).toEqual([]);
		expect(normalized.manifest.projection?.providers).toEqual(hostedResponse.manifest.providers);
		expect(normalized.manifest.egressProfiles?.profiles.map((profile) => profile.id)).toContain(
			"api-proxy",
		);
		expect(normalized.manifest.liveSync).toEqual(hostedResponse.manifest.liveSync);
		expect("secretValues" in normalized.manifest).toBe(false);
		expect(normalized.secretValues).toEqual({
			"providers/default/api-key": "sk-normalized",
			"secret://providers/default/api-key": "sk-normalized",
		});
	});

	test("rejects a missing explicit runtime even with one runtime entry", () => {
		expect(
			hostedRuntimeManifestSchema.safeParse({
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
				deploymentId: "hdep_infer_runtime",
				environmentId: "env_infer_runtime",
				instanceId: "hri_infer_runtime",
				generation: 1,
				issuedAt: "2026-07-07T00:00:00.000Z",
				locale: TEST_HOSTED_LOCALE,
				system: hostedSystemFixture(),
				controlPlane: {
					cloudApiUrl: "https://cloud-api.example.test",
				},
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: "clawdi@agent-v2",
					registry: "https://registry.npmjs.org",
				},
				providers: {
					default: {
						kind: "openai-compatible",
						status: "error",
						error: { code: "provider_not_found" },
					},
				},
				liveSync: { enabled: false, agents: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
				runtimes: {
					openclaw: hostedRuntimeFixture({ install: { source: "official" } }),
				},
			}).success,
		).toBe(false);
	});

	test.each([
		["top level", (manifest: Record<string, unknown>) => ({ ...manifest, unknown: true })],
		[
			"system",
			(manifest: Record<string, unknown>) => ({
				...manifest,
				system: hostedSystemFixture({ unknown: true }),
			}),
		],
		[
			"control plane",
			(manifest: Record<string, unknown>) => ({
				...manifest,
				controlPlane: {
					...(manifest.controlPlane as Record<string, unknown>),
					unknown: true,
				},
			}),
		],
		[
			"runtime entry",
			(manifest: Record<string, unknown>) => ({
				...manifest,
				runtimes: {
					openclaw: {
						...((manifest.runtimes as Record<string, unknown>).openclaw as Record<string, unknown>),
						unknown: true,
					},
				},
			}),
		],
		[
			"runtime run settings",
			(manifest: Record<string, unknown>) => ({
				...manifest,
				runtimes: {
					openclaw: {
						...((manifest.runtimes as Record<string, unknown>).openclaw as Record<string, unknown>),
						run: {
							command: "openclaw",
							args: ["gateway", "run"],
							env: {},
							prependPath: [],
							unknown: true,
						},
					},
				},
			}),
		],
	])("rejects unknown hosted manifest fields at the %s", (_name, addUnknownField) => {
		const cleanManifest = {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
			runtime: "openclaw",
			deploymentId: "hdep_forward_compat",
			environmentId: "env_forward_compat",
			instanceId: "hri_forward_compat",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			locale: TEST_HOSTED_LOCALE,
			controlPlane: {
				cloudApiUrl: "https://cloud-api.example.test",
			},
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@agent-v2",
				registry: "https://registry.npmjs.org",
			},
			runtimes: {
				openclaw: {
					enabled: true,
					run: {
						command: "openclaw",
						args: ["gateway", "run"],
						env: {},
						prependPath: [],
					},
				},
			},
		};

		expect(hostedRuntimeManifestSchema.safeParse(addUnknownField(cleanManifest)).success).toBe(
			false,
		);
	});

	test("rejects hosted manifests that still declare multiple execution runtimes", () => {
		expect(() =>
			hostedRuntimeManifestSchema.parse({
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				minimumCliVersion: TEST_HOSTED_MINIMUM_CLI_VERSION,
				runtime: "openclaw",
				deploymentId: "hdep_multi",
				environmentId: "env_multi",
				instanceId: "hri_multi",
				generation: 1,
				issuedAt: "2026-07-01T00:00:00.000Z",
				locale: TEST_HOSTED_LOCALE,
				system: hostedSystemFixture(),
				controlPlane: {
					cloudApiUrl: "https://cloud-api.example.test",
				},
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: "clawdi@agent-v2",
					registry: "https://registry.npmjs.org",
				},
				providers: {
					default: {
						kind: "openai-compatible",
						status: "error",
						error: { code: "provider_not_found" },
					},
				},
				liveSync: { enabled: false, agents: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
				runtimes: {
					openclaw: {
						enabled: true,
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-test" },
						paths: { home: TEST_HOSTED_HOME, workspace: TEST_HOSTED_WORKSPACE },
						run: { command: "openclaw", args: ["gateway", "run"] },
					},
					hermes: {
						enabled: true,
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-test" },
						paths: { home: TEST_HOSTED_HOME, workspace: TEST_HOSTED_WORKSPACE },
						run: { command: "hermes", args: ["gateway", "run"] },
					},
				},
				bridge: { surfaces: [] },
			}),
		).toThrow("hosted runtime manifests must declare exactly one selected runtime");
	});

	test("converges OpenClaw native token auth from env secret refs", () => {
		const paths = tempRuntimePaths();
		process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: {
						command: "openclaw",
						args: [
							"gateway",
							"run",
							"--allow-unconfigured",
							"--auth",
							"token",
							"--bind",
							"lan",
							"--force",
						],
						env: {},
						secretEnv: {
							OPENCLAW_GATEWAY_TOKEN: "env://OPENCLAW_GATEWAY_TOKEN",
						},
						prependPath: [],
					},
					services: {},
				},
			},
			{ runtime: "openclaw", bridge: { surfaces: [] } },
		);

		const result = convergeRuntimeManifest(manifestLoad(manifest, "inline-openclaw"), paths);

		expect(result.installErrors).toEqual([]);
		expect(result.enabledRuntimes).toEqual(["openclaw"]);
		expect(result.outputs.systemdUserUnits.map((path) => path.split("/").at(-1))).toEqual([
			"openclaw-gateway.service",
		]);
		const runConfig = JSON.parse(readFileSync(runtimeRunConfigPath("openclaw", paths), "utf8")) as {
			defaultArgs?: string[];
			secretEnv?: Record<string, string>;
			secretFilePath?: string | null;
		};
		expect(runConfig.defaultArgs).toEqual([
			"gateway",
			"run",
			"--allow-unconfigured",
			"--auth",
			"token",
			"--bind",
			"lan",
			"--force",
		]);
		expect(runConfig.secretEnv).toEqual({
			OPENCLAW_GATEWAY_TOKEN: "env://OPENCLAW_GATEWAY_TOKEN",
		});
		expect(runConfig.secretFilePath).toBeNull();
		expect(runtimeSecretValue({}, "env://OPENCLAW_GATEWAY_TOKEN")).toBe("gateway-token");
		const unit = readFileSync(
			join(paths.systemdUserRoot, "openclaw-gateway.service.d", "10-clawdi-hosted.conf"),
			"utf8",
		);
		expect(unit).toContain(
			'ExecStart="openclaw" "gateway" "run" "--allow-unconfigured" "--auth" "token" "--bind" "lan" "--force"',
		);
		const envFile = readFileSync(
			join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
			"utf8",
		);
		expect(envFile).toContain('OPENCLAW_GATEWAY_TOKEN="gateway-token"');
	});

	test("keeps hosted managed provider key out of the agent env", () => {
		const paths = tempRuntimePaths();
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings("openclaw", ["gateway", "run"]),
					services: {},
				},
			},
			{
				runtime: "openclaw",
				projection: {
					providers: {
						default: {
							type: "custom_openai_compatible",
							// managed_by:"clawdi" marks this as a Clawdi-managed provider
							// (cloud-api emits it as `n:"clawdi"`), which routes the key
							// through the egress placeholder path — the agent env gets the
							// placeholder while the real key stays out of its env.
							managed_by: "clawdi",
							baseUrl: "https://api.example.test/v1",
							model: "gpt-test",
							apiMode: "openai_chat",
							runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
							apiKeySecretRef: "secret://providers/default/api-key",
						},
					},
				},
			},
		);

		const result = convergeRuntimeManifest(
			manifestLoad(manifest, "inline-managed-provider", {
				"secret://providers/default/api-key": "sk-managed",
			}),
			paths,
		);

		expect(result.installErrors).toEqual([]);
		const runConfig = JSON.parse(readFileSync(runtimeRunConfigPath("openclaw", paths), "utf8")) as {
			env?: Record<string, string>;
		};
		expect(runConfig.env?.CLAWDI_MANAGED_OPENAI_API_KEY).toBeUndefined();
		expect(runConfig.env?.OPENAI_API_KEY).toBe("clawdi-egress-placeholder");
		const envFile = readFileSync(
			join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
			"utf8",
		);
		expect(envFile).not.toContain("CLAWDI_MANAGED_OPENAI_API_KEY");
		expect(envFile).toContain('OPENAI_API_KEY="clawdi-egress-placeholder"');
		expect(envFile).not.toContain("sk-managed");
	});

	test("projects managed hosted providers with only the live primary model seed", () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings("openclaw", ["gateway", "run"]),
					primary_model: { provider_id: "default", model: "gpt-live" },
					services: {},
				},
			},
			{
				projection: {
					providers: {
						default: {
							type: "custom_openai_compatible",
							managed_by: "clawdi",
							baseUrl: "https://api.example.test/v1",
							model: "gpt-legacy",
							models: [{ id: "stale-a" }, { id: "stale-b" }],
							apiMode: "openai_chat",
							runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
							apiKeySecretRef: "secret://providers/default/api-key",
						},
					},
				},
			},
		);

		const projection = hostedAiProviderCatalog(manifest, "openclaw");
		expect(projection?.primaryModel).toEqual({ provider_id: "default", model: "gpt-live" });
		expect(projection?.catalog.providers[0]?.models).toEqual([
			{ id: "gpt-live", api_mode: "openai_chat" },
		]);
	});

	test("preserves hosted provider model alias and cost metadata", () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings("openclaw", ["gateway", "run"]),
					provider_ids: ["custom"],
					primary_model: { provider_id: "custom", model: "example-model" },
					services: {},
				},
			},
			{
				projection: {
					providers: {
						custom: {
							type: "custom_openai_compatible",
							baseUrl: "https://api.example.test/v1",
							apiMode: "openai_chat",
							models: [
								{
									id: "example-model",
									alias: "Example Model",
									context_window: 128_000,
									cost: {
										input: 0.3,
										output: 1.2,
										cache_read: 0.06,
										cache_write: 0,
									},
								},
							],
							runtimeEnvName: "CUSTOM_API_KEY",
							apiKeySecretRef: "secret://providers/custom/api-key",
						},
					},
				},
			},
		);

		const projection = hostedAiProviderCatalog(manifest, "openclaw");
		expect(projection?.catalog.providers[0]?.models).toEqual([
			{
				id: "example-model",
				alias: "Example Model",
				context_window: 128_000,
				cost: {
					input: 0.3,
					output: 1.2,
					cache_read: 0.06,
					cache_write: 0,
				},
			},
		]);
	});

	test("applies a managed primary model override to the hosted provider seed projection", () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings("openclaw", ["gateway", "run"]),
					services: {},
				},
			},
			{
				projection: {
					providers: {
						default: {
							type: "custom_openai_compatible",
							managed_by: "clawdi",
							baseUrl: "https://api.example.test/v1",
							apiMode: "openai_chat",
							apiKeySecretRef: "secret://providers/default/api-key",
						},
					},
				},
			},
		);

		const projection = hostedAiProviderCatalog(manifest, "openclaw", {
			primaryModelOverride: { provider_id: "default", model: "gpt-5.6" },
		});
		expect(projection?.primaryModel).toEqual({ provider_id: "default", model: "gpt-5.6" });
		expect(projection?.catalog.providers[0]?.models).toEqual([
			{ id: "gpt-5.6", api_mode: "openai_chat" },
		]);
	});

	test("keeps runtime secret revisions separate from bridge sidecar revisions", () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(paths, {
			openclaw: {
				enabled: true,
				run: runSettings("openclaw", ["gateway", "run"]),
				services: {},
			},
		});
		const secretValues = {
			"secret://providers/default/api-key": "sk-before",
		};
		const rotatedSecretValues = {
			"secret://providers/default/api-key": "sk-after",
		};
		const metadataOnlyChange: RuntimeManifest = {
			...manifest,
			generation: 2,
			issuedAt: "2026-07-01T00:01:00.000Z",
		};

		const runtimeRevision = runtimeProgramRevision(manifest, "openclaw", secretValues);
		expect(runtimeProgramRevision(manifest, "openclaw", rotatedSecretValues)).not.toBe(
			runtimeRevision,
		);
		expect(runtimeProgramRevision(metadataOnlyChange, "openclaw", secretValues)).toBe(
			runtimeRevision,
		);

		const sidecarRevision = runtimeSidecarProgramRevision(manifest, secretValues);
		expect(runtimeSidecarProgramRevision(manifest, rotatedSecretValues)).toBe(sidecarRevision);
		expect(runtimeSidecarProgramRevision(metadataOnlyChange, secretValues)).not.toBe(
			sidecarRevision,
		);
	});

	test("advances last-good manifest only after a clean converge", () => {
		const paths = tempRuntimePaths();
		const openclawCommand = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "1";
		const manifest = baseManifest(paths, {
			openclaw: {
				enabled: true,
				run: runSettings(openclawCommand, ["gateway", "run"]),
				services: {},
			},
		});

		writeFakeGatewayCli({ path: openclawCommand, runtime: "openclaw", unitPath });
		const clean = convergeRuntimeManifest(manifestLoad(manifest, "inline-clean"), paths);
		expect(clean.installErrors).toEqual([]);
		expect(clean.outputs.manifestLastGood).toBe(paths.manifestLastGood);
		expect(JSON.parse(readFileSync(paths.manifestLastGood, "utf8"))).toMatchObject({
			generation: 1,
		});

		writeFakeGatewayCli({
			path: openclawCommand,
			runtime: "openclaw",
			unitPath,
			failInstall: true,
		});
		const failedManifest: RuntimeManifest = {
			...manifest,
			generation: 2,
			issuedAt: "2026-07-01T00:02:00.000Z",
		};
		const failed = convergeRuntimeManifest(
			manifestLoad(failedManifest, "inline-install-error"),
			paths,
		);

		expect(failed.installErrors.join("\n")).toContain(
			"official openclaw-gateway service install failed",
		);
		expect(failed.outputs.manifestLastGood).toBeNull();
		expect(JSON.parse(readFileSync(paths.manifestLastGood, "utf8"))).toMatchObject({
			generation: 1,
		});
	});

	test("garbage collects stale run configs when a runtime is removed", () => {
		const paths = tempRuntimePaths();
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
		const initialManifest = baseManifest(paths, {
			hermes: {
				enabled: true,
				run: runSettings("hermes", ["gateway", "run"]),
				services: {},
			},
			openclaw: {
				enabled: true,
				run: runSettings("openclaw", ["gateway", "run"]),
				services: {},
			},
		});
		const openclawRunConfig = runtimeRunConfigPath("openclaw", paths);
		const hermesRunConfig = runtimeRunConfigPath("hermes", paths);

		const initial = convergeRuntimeManifest(manifestLoad(initialManifest, "inline-initial"), paths);
		expect(initial.installErrors).toEqual([]);
		expect(existsSync(openclawRunConfig)).toBe(true);
		expect(existsSync(hermesRunConfig)).toBe(true);

		const nextManifest = baseManifest(
			paths,
			{
				hermes: {
					enabled: true,
					run: runSettings("hermes", ["gateway", "run"]),
					services: {},
				},
			},
			{ generation: 2, issuedAt: "2026-07-01T00:03:00.000Z" },
		);
		const next = convergeRuntimeManifest(manifestLoad(nextManifest, "inline-removed"), paths);

		expect(next.installErrors).toEqual([]);
		expect(existsSync(openclawRunConfig)).toBe(false);
		expect(existsSync(hermesRunConfig)).toBe(true);
	});

	test("resolves runtime secret refs by exact, normalized, and stripped forms", () => {
		expect(
			runtimeSecretValue(
				{ "secret://providers/default/api-key": "sk-exact" },
				"secret://providers/default/api-key",
			),
		).toBe("sk-exact");
		expect(
			runtimeSecretValue(
				{ "secret://providers/default/api-key": "sk-normalized" },
				"providers/default/api-key",
			),
		).toBe("sk-normalized");
		expect(
			runtimeSecretValue(
				{ "providers/default/api-key": "sk-stripped" },
				"secret://providers/default/api-key",
			),
		).toBe("sk-stripped");
		expect(runtimeSecretValue({}, "secret://providers/default/api-key")).toBeNull();
	});
});
