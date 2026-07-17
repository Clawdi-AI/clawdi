import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	convergeRuntimeManifest,
	hostedAiProviderCatalog,
	type RuntimeManifest,
	runtimeLiveSnapshotPaths,
	runtimeProgramRevision,
	runtimeSecretValue,
	runtimeSidecarProgramRevision,
} from "./manifest";
import {
	hostedRuntimeManifestFixtureResponseSchema,
	hostedRuntimeManifestResponseSchema,
	hostedRuntimeManifestSchema,
	manifestSchema,
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
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";

const originalEnv = { ...process.env };
const tempRoots: string[] = [];
const TEST_HOSTED_LOCALE = { language: "en" as const, timezone: "UTC" };
const TEST_HOSTED_MINIMUM_CLI_VERSION = "0.12.10-beta.55";
const TEST_HOSTED_HOME = "/home/clawdi";
const TEST_HOSTED_CODEX_TOOLING = {
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
};

function hostedSystemFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return overrides;
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
			packageSpec: "clawdi@0.12.10-beta.55",
			registry: "https://registry.npmjs.org",
		},
		providers: {
			default: {
				kind: "openai-compatible",
				status: "error",
				error: { code: "provider_not_found", message: "fixture provider unavailable" },
			},
		},
		terminalTooling: structuredClone(TEST_HOSTED_CODEX_TOOLING),
		liveSync: { enabled: false, agents: [] },
		recovery: { cacheManifest: true, allowOfflineBoot: true },
		runtimes: {
			openclaw: {
				enabled: true,
				install: { source: "official" },
				providerMode: "configured",
				provider_ids: ["default"],
				primary_model: { provider_id: "default", model: "gpt-test" },
			},
		},
		...overrides,
	};
}

function hostedRuntimeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		enabled: true,
		install: { source: "official" },
		providerMode: "configured",
		provider_ids: ["default"],
		primary_model: { provider_id: "default", model: "gpt-test" },
		...overrides,
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

	test("accepts and preserves canonical hosted model capability fields", () => {
		const parsed = hostedRuntimeManifestSchema.parse(
			hostedManifestFixture({
				providers: {
					default: {
						kind: "openai-compatible",
						type: "custom_openai_compatible",
						baseUrl: "https://provider.example.test/v1",
						apiMode: "openai_chat",
						managed_by: "clawdi",
						runtimeEnvName: "OPENAI_API_KEY",
						models: [
							{
								id: "k3",
								context_window: 1_048_576,
								max_input_tokens: 229_376,
								max_tokens: 32_768,
								input_modalities: ["text", "image"],
								supports_tools: true,
								supports_reasoning: true,
							},
						],
					},
				},
				runtimes: {
					openclaw: hostedRuntimeFixture({
						primary_model: { provider_id: "default", model: "k3" },
					}),
				},
			}),
		);
		const manifest = hostedManifestToRuntimeManifest(parsed);
		expect(manifest.projection?.providers?.default).toMatchObject({
			models: [
				{
					id: "k3",
					context_window: 1_048_576,
					max_input_tokens: 229_376,
					max_tokens: 32_768,
					input_modalities: ["text", "image"],
					supports_tools: true,
					supports_reasoning: true,
				},
			],
		});
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

	test("accepts explicit unmanaged provider mode without provider state", () => {
		const runtime = hostedRuntimeFixture({
			providerMode: "unmanaged",
			provider_ids: [],
		});
		delete runtime.primary_model;
		const parsed = hostedRuntimeManifestSchema.parse(
			hostedManifestFixture({
				providers: {},
				runtimes: { openclaw: runtime },
			}),
		);
		const normalized = hostedManifestToRuntimeManifest(parsed);
		expect(normalized.runtimes.openclaw).toMatchObject({
			providerMode: "unmanaged",
			provider_ids: [],
		});
		expect(normalized.runtimes.openclaw.primary_model).toBeUndefined();
		expect(normalized.projection?.providers).toEqual({});
	});

	test.each([
		[
			"unmanaged provider ids",
			hostedRuntimeFixture({ providerMode: "unmanaged", provider_ids: ["default"] }),
		],
		[
			"unmanaged primary model",
			hostedRuntimeFixture({ providerMode: "unmanaged", provider_ids: [] }),
		],
		[
			"configured empty provider ids",
			hostedRuntimeFixture({ providerMode: "configured", provider_ids: [] }),
		],
		[
			"missing provider mode",
			(() => {
				const runtime = hostedRuntimeFixture();
				delete runtime.providerMode;
				return runtime;
			})(),
		],
	])("rejects mixed provider contract: %s", (_name, runtime) => {
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({ runtimes: { openclaw: runtime } }),
			).success,
		).toBe(false);
	});

	test.each([
		["run provider env", { run: { env: { OPENAI_API_KEY: "configured" } } }],
		["run placeholder", { run: { env: { TOKEN: "clawdi-egress-placeholder" } } }],
		[
			"run provider secret ref",
			{ run: { secretEnv: { OPENAI_API_KEY: "provider.clawdi-managed-v2.apiKey" } } },
		],
		[
			"service provider secret ref",
			{ services: { helper: { secretEnv: { TOKEN: "secret://provider.runtime.apiKey" } } } },
		],
	])("rejects unmanaged runtime %s", (_name, overrides) => {
		const runtime = hostedRuntimeFixture({
			providerMode: "unmanaged",
			provider_ids: [],
			primary_model: undefined,
			...overrides,
		});
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({ providers: {}, runtimes: { openclaw: runtime } }),
			).success,
		).toBe(false);
	});

	test("allows an explicit user Vault-backed service secret ref in unmanaged mode", () => {
		const runtime = hostedRuntimeFixture({
			providerMode: "unmanaged",
			provider_ids: [],
			services: { helper: { secretEnv: { TOKEN: "clawdi://default/key" } } },
		});
		delete runtime.primary_model;

		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({ providers: {}, runtimes: { openclaw: runtime } }),
			).success,
		).toBe(true);
	});

	test("rejects terminal Codex without its fixed process env contract", () => {
		const terminalTooling = structuredClone(TEST_HOSTED_CODEX_TOOLING);
		terminalTooling.codex.provider.runtimeEnvName = "CLAWDI_MANAGED_OPENAI_API_KEY";
		const manifest = hostedManifestFixture({ terminalTooling });
		expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(false);
	});

	test("rejects the legacy managed runtime env-name rewrite contract", () => {
		const provider = {
			...TEST_HOSTED_CODEX_TOOLING.codex.provider,
			runtimeEnvName: "CLAWDI_MANAGED_OPENAI_API_KEY",
			apiKeySecretRef: "provider.default.apiKey",
		};
		const manifest = hostedManifestFixture({ providers: { default: provider } });

		expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(false);
	});

	test("rejects terminal Codex with a runtime-provider secret ref", () => {
		const terminalTooling = structuredClone(TEST_HOSTED_CODEX_TOOLING);
		terminalTooling.codex.provider.apiKeySecretRef = "provider.codex-managed.apiKey";
		const manifest = hostedManifestFixture({ terminalTooling });
		expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(false);
	});

	test.each([
		"openai_chat",
		"anthropic_messages",
		"google_generate_content",
	])("rejects terminal Codex without the fixed responses API mode (%s)", (apiMode) => {
		const terminalTooling = structuredClone(TEST_HOSTED_CODEX_TOOLING);
		terminalTooling.codex.provider.apiMode = apiMode;
		const manifest = hostedManifestFixture({ terminalTooling });
		expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(false);
	});

	test("rejects terminal Codex without an API mode", () => {
		const { apiMode: _apiMode, ...provider } = TEST_HOSTED_CODEX_TOOLING.codex.provider;
		const terminalTooling = {
			codex: { ...TEST_HOSTED_CODEX_TOOLING.codex, provider },
		};
		const manifest = hostedManifestFixture({ terminalTooling });
		expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(false);
	});

	test.each([
		"provider.stale.apiKey",
		"secret://provider.stale.apiKey",
	])("rejects provider secret value %s in unmanaged mode", (secretRef) => {
		const runtime = hostedRuntimeFixture({
			providerMode: "unmanaged",
			provider_ids: [],
		});
		delete runtime.primary_model;
		const manifest = hostedManifestFixture({
			providers: {},
			runtimes: { openclaw: runtime },
		});
		expect(
			hostedRuntimeManifestResponseSchema.safeParse({
				manifest,
				secretValues: { [secretRef]: "secret" },
			}).success,
		).toBe(false);
	});

	test("accepts either Codex tool secret-ref alias in unmanaged mode", () => {
		const runtime = hostedRuntimeFixture({ providerMode: "unmanaged", provider_ids: [] });
		delete runtime.primary_model;
		const manifest = hostedManifestFixture({ providers: {}, runtimes: { openclaw: runtime } });
		const codexRef = TEST_HOSTED_CODEX_TOOLING.codex.provider.apiKeySecretRef;
		expect(codexRef).toBeDefined();
		for (const secretRef of [codexRef, `secret://${codexRef}`]) {
			expect(
				hostedRuntimeManifestResponseSchema.safeParse({
					manifest,
					secretValues: { [secretRef]: "secret" },
				}).success,
			).toBe(true);
		}
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
		["missing install", { install: undefined }],
		["remote install channel", { install: { source: "official", channel: "stable" } }],
		["remote install args", { install: { source: "official", args: [] } }],
	])("rejects hosted runtime with %s", (_name, overrides) => {
		const runtime = hostedRuntimeFixture(overrides);
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({ runtimes: { openclaw: runtime } }),
			).success,
		).toBe(false);
	});

	test("preserves generic runtime install defaults and provider model projections", () => {
		const parsed = manifestSchema.parse({
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "dep_generic",
			environmentId: "env_generic",
			instanceId: "iid_generic",
			generation: 1,
			issuedAt: "2026-07-12T00:00:00.000Z",
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			runtimes: {
				custom: {
					enabled: true,
					updateChannel: "stable",
					install: {
						authority: "official",
						method: "official-installer",
						url: "https://runtime.example.test/install.sh",
						home: "/home/runtime",
					},
				},
			},
			projection: { providers: { default: { model: "legacy-model" } } },
			recovery: {},
		});

		expect(parsed.runtimes.custom.install?.args).toEqual([]);
		expect(parsed.runtimes.custom.updateChannel).toBe("stable");
		expect(parsed.projection?.providers?.default).toEqual({ model: "legacy-model" });
	});

	test.each([
		"system.user",
		"system.home",
		"system.workspace",
		"system.persistentPaths",
		"runtime.paths",
	])("rejects obsolete hosted manifest field %s", (field) => {
		const manifest = structuredClone(hostedManifestFixture()) as Record<string, unknown>;
		const system = manifest.system as Record<string, unknown>;
		const runtimes = manifest.runtimes as Record<string, Record<string, unknown>>;
		const runtime = runtimes.openclaw;
		if (field === "system.user") system.user = "clawdi";
		if (field === "system.home") system.home = TEST_HOSTED_HOME;
		if (field === "system.workspace") system.workspace = TEST_HOSTED_HOME;
		if (field === "system.persistentPaths") system.persistentPaths = [TEST_HOSTED_HOME];
		if (field === "runtime.paths") runtime.paths = { home: TEST_HOSTED_HOME };

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
		["empty provider", {}],
		[
			"unsupported kind",
			{
				kind: "anthropic-compatible",
				type: "anthropic",
				baseUrl: "https://api.anthropic.com",
			},
		],
		["kind only", { kind: "openai-compatible" }],
		[
			"error status without error",
			{
				kind: "openai-compatible",
				type: "custom_openai_compatible",
				baseUrl: "https://provider.example.test/v1",
				status: "error",
			},
		],
		[
			"error without error status",
			{
				kind: "openai-compatible",
				type: "custom_openai_compatible",
				baseUrl: "https://provider.example.test/v1",
				error: {
					code: "provider_secret_unavailable",
					message: "provider secret is unavailable",
				},
			},
		],
		[
			"non-not-found error without normal projection",
			{
				kind: "openai-compatible",
				status: "error",
				error: {
					code: "provider_secret_unavailable",
					message: "provider secret is unavailable",
				},
			},
		],
		[
			"provider_not_found without error message",
			{
				kind: "openai-compatible",
				status: "error",
				error: { code: "provider_not_found" },
			},
		],
		[
			"provider_secret_unavailable without error message",
			{
				kind: "openai-compatible",
				type: "anthropic",
				baseUrl: "https://api.anthropic.com",
				status: "error",
				error: { code: "provider_secret_unavailable" },
			},
		],
		[
			"empty error message",
			{
				kind: "openai-compatible",
				status: "error",
				error: { code: "provider_not_found", message: "" },
			},
		],
		[
			"singular model alias",
			{
				kind: "openai-compatible",
				type: "custom_openai_compatible",
				baseUrl: "https://provider.example.test/v1",
				model: "gpt-test",
			},
		],
	])("rejects hosted manifests with %s", (_name, provider) => {
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({ providers: { default: provider } }),
			).success,
		).toBe(false);
	});

	test.each([
		[
			"provider_not_found projection",
			{
				kind: "openai-compatible",
				status: "error",
				error: { code: "provider_not_found", message: "provider is missing" },
			},
		],
		[
			"provider_secret_unavailable projection",
			{
				kind: "openai-compatible",
				type: "anthropic",
				baseUrl: "https://api.anthropic.com",
				apiMode: "anthropic_messages",
				models: [{ id: "claude-opus-4-6" }],
				runtimeEnvName: "ANTHROPIC_API_KEY",
				apiKeyRequired: true,
				status: "error",
				error: {
					code: "provider_secret_unavailable",
					message: "provider secret is unavailable",
				},
			},
		],
		[
			"healthy provider projection",
			{
				kind: "openai-compatible",
				type: "custom_openai_compatible",
				baseUrl: "https://provider.example.test/v1",
				apiMode: "openai_chat",
				models: [{ id: "gpt-test" }],
				apiKeySecretRef: "provider.default.apiKey",
			},
		],
	])("accepts Cloud %s", (_name, provider) => {
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({ providers: { default: provider } }),
			).success,
		).toBe(true);
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
					openclawControlUiAllowedOrigins: allowedOrigins,
				}),
				runtimes: {
					openclaw: {
						enabled: true,
						install: { source: "official" },
						providerMode: "configured",
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-test" },
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
				packageSpec: "clawdi@0.12.10-beta.55",
				registry: "https://registry.npmjs.org",
			},
		},
		{
			name: "missing registry",
			clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@0.12.10-beta.55" },
		},
		{
			name: "non-official registry",
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@0.12.10-beta.55",
				registry: "https://registry.example.test",
			},
		},
		{
			name: "dead managed flags",
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@0.12.10-beta.55",
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
		"clawdi@0.12.10-beta.55",
		"clawdi@1.2.3-rc-1.2",
		"clawdi@1.2.3",
	])("accepts exact hosted CLI package spec %s", (packageSpec) => {
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

	test("enforces the Cloud package spec length limit for remote and fixture Hosted schemas", () => {
		const atLimit = `clawdi@1.2.3-${"a".repeat(187)}`;
		const overLimit = `clawdi@1.2.3-${"a".repeat(188)}`;
		expect(atLimit).toHaveLength(200);
		expect(overLimit).toHaveLength(201);

		for (const packageSpec of [atLimit, overLimit]) {
			const manifest = hostedManifestFixture({
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec,
					registry: "https://registry.npmjs.org",
				},
			});
			const expected = packageSpec === atLimit;
			expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(expected);
			expect(
				hostedRuntimeManifestFixtureResponseSchema.safeParse({
					manifest,
					secretValues: {},
				}).success,
			).toBe(expected);
		}
	});

	test.each([
		"clawdi@agent-v2",
		"clawdi@latest",
		"clawdi@beta",
		"clawdi",
		"clawdi@candidate",
		"clawdi@1.2.3+build.1",
		"clawdi@1.2.3-beta..1",
		"clawdi@1.2.3-beta.",
		"clawdi@1.2.3-.beta",
		"clawdi@1.2.3-01",
		"clawdi@01.2.3",
		"./clawdi.tgz",
		"/tmp/clawdi.tgz",
		"/usr/local/share/clawdi/bootstrap/clawdi-0.12.10-beta.55.tgz",
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
				system: hostedSystemFixture(),
				controlPlane: {
					cloudApiUrl: "https://cloud-api.example.test",
				},
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: "clawdi@0.12.10-beta.55",
					registry: "https://registry.npmjs.org",
				},
				runtimes: {
					openclaw: {
						enabled: true,
						providerMode: "configured",
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-test" },
						install: { source: "official" },
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
					},
				},
				bridge: { surfaces: [] },
				providers: {
					default: {
						kind: "openai-compatible",
						type: "custom_openai_compatible",
						baseUrl: "https://api.example.test/v1",
						models: [{ id: "gpt-test" }],
						apiMode: "openai_chat",
						apiKeySecretRef: "secret://providers/default/api-key",
					},
				},
				terminalTooling: TEST_HOSTED_CODEX_TOOLING,
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
		expect(normalized.manifest.runtimes.openclaw.updateChannel).toBeUndefined();
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
					packageSpec: "clawdi@0.12.10-beta.55",
					registry: "https://registry.npmjs.org",
				},
				providers: {
					default: {
						kind: "openai-compatible",
						status: "error",
						error: { code: "provider_not_found", message: "provider is missing" },
					},
				},
				terminalTooling: TEST_HOSTED_CODEX_TOOLING,
				liveSync: { enabled: false, agents: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
				runtimes: {
					openclaw: hostedRuntimeFixture(),
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
				packageSpec: "clawdi@0.12.10-beta.55",
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
					packageSpec: "clawdi@0.12.10-beta.55",
					registry: "https://registry.npmjs.org",
				},
				providers: {
					default: {
						kind: "openai-compatible",
						status: "error",
						error: { code: "provider_not_found", message: "provider is missing" },
					},
				},
				terminalTooling: TEST_HOSTED_CODEX_TOOLING,
				liveSync: { enabled: false, agents: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
				runtimes: {
					openclaw: {
						enabled: true,
						install: { source: "official" },
						providerMode: "configured",
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-test" },
						run: { command: "openclaw", args: ["gateway", "run"] },
					},
					hermes: {
						enabled: true,
						install: { source: "official" },
						providerMode: "configured",
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-test" },
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
					provider_ids: ["default"],
					primary_model: { provider_id: "default", model: "gpt-test" },
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
							runtimeEnvName: "OPENAI_API_KEY",
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

	test("preserves managed hosted provider model capabilities after primary resolution", () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings("openclaw", ["gateway", "run"]),
					provider_ids: ["default"],
					primary_model: { provider_id: "default", model: "k3" },
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
							models: [
								{
									id: "k3",
									context_window: 1_048_576,
									max_input_tokens: 229_376,
									max_tokens: 32_768,
									input_modalities: ["text", "image"],
									supports_tools: true,
									supports_reasoning: true,
								},
								{ id: "kimi-for-coding" },
								{ id: "kimi-for-coding-highspeed", context_window: 262_144 },
							],
							apiMode: "openai_chat",
							runtimeEnvName: "OPENAI_API_KEY",
							apiKeySecretRef: "secret://providers/default/api-key",
						},
					},
				},
			},
		);

		const projection = hostedAiProviderCatalog(manifest, "openclaw");
		expect(projection?.primaryModel).toEqual({ provider_id: "default", model: "k3" });
		expect(projection?.catalog.providers[0]?.models).toEqual([
			{
				id: "k3",
				context_window: 1_048_576,
				max_input_tokens: 229_376,
				max_tokens: 32_768,
				input_modalities: ["text", "image"],
				supports_tools: true,
				supports_reasoning: true,
			},
			{ id: "kimi-for-coding" },
			{ id: "kimi-for-coding-highspeed", context_window: 262_144 },
		]);
	});

	test.each([
		"openclaw",
		"default",
	])("does not infer strict hosted provider bindings from the %s provider key", (providerKey) => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings("openclaw", ["gateway", "run"]),
					provider_ids: ["default"],
					services: {},
				},
			},
			{
				projection: {
					sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
					providers: {
						[providerKey]: {
							type: "custom_openai_compatible",
							baseUrl: "https://api.example.test/v1",
							model: "gpt-inferred",
							models: [{ id: "gpt-inferred" }],
							apiMode: "openai_chat",
						},
					},
				},
			},
		);

		expect(hostedAiProviderCatalog(manifest, "openclaw")).toBeNull();
	});

	test("does not infer a strict hosted primary model from the first provider", () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings("openclaw", ["gateway", "run"]),
					provider_ids: ["default"],
					services: {},
				},
			},
			{
				projection: {
					sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
					providers: {
						default: {
							type: "custom_openai_compatible",
							baseUrl: "https://api.example.test/v1",
							model: "gpt-inferred",
							models: [{ id: "gpt-inferred" }],
							apiMode: "openai_chat",
						},
					},
				},
			},
		);

		expect(hostedAiProviderCatalog(manifest, "openclaw")).toBeNull();
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

	test("merges a discovered managed catalog with matching wire capabilities", () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings("openclaw", ["gateway", "run"]),
					provider_ids: ["default"],
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
							models: [
								{
									id: "kimi-for-coding",
									context_window: 262_144,
									max_input_tokens: 229_376,
									max_tokens: 32_768,
									supports_tools: true,
								},
								{
									id: "kimi-for-coding-highspeed",
									context_window: 262_144,
									max_input_tokens: 229_376,
									supports_tools: true,
								},
							],
							apiKeySecretRef: "secret://providers/default/api-key",
						},
					},
				},
			},
		);

		const projection = hostedAiProviderCatalog(manifest, "openclaw", {
			primaryModelOverride: { provider_id: "default", model: "kimi-for-coding-highspeed" },
			managedModelsOverride: [
				{ id: "kimi-for-coding" },
				{
					id: "kimi-for-coding-highspeed",
					context_window: 262_144,
					max_input_tokens: 229_376,
					supports_tools: true,
				},
			],
		});
		expect(projection?.primaryModel).toEqual({
			provider_id: "default",
			model: "kimi-for-coding-highspeed",
		});
		expect(projection?.catalog.providers[0]?.models).toEqual([
			{
				id: "kimi-for-coding",
				context_window: 262_144,
				max_input_tokens: 229_376,
				max_tokens: 32_768,
				supports_tools: true,
			},
			{
				id: "kimi-for-coding-highspeed",
				context_window: 262_144,
				max_input_tokens: 229_376,
				supports_tools: true,
			},
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
		expect(clean.outputs.appliedState).toBeNull();
		expect(existsSync(paths.appliedState)).toBe(false);
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
		let authorityCommits = 0;
		const failed = convergeRuntimeManifest(
			manifestLoad(failedManifest, "inline-install-error"),
			paths,
			{ commitAuthority: () => authorityCommits++ },
		);

		expect(failed.installErrors.join("\n")).toContain(
			"official openclaw-gateway service install failed",
		);
		expect(failed.outputs.manifestLastGood).toBeNull();
		expect(authorityCommits).toBe(0);
		expect(JSON.parse(readFileSync(paths.manifestLastGood, "utf8"))).toMatchObject({
			generation: 1,
		});
	});

	test("does not mutate live state when runtime planning fails", () => {
		const paths = tempRuntimePaths();
		const workspaceRoot = join(paths.userHome, "clawdi");
		const soulPath = join(workspaceRoot, "SOUL.md");
		const staleRunConfig = join(paths.runConfigRoot, "stale-runtime.json");
		const runtimeSecret = join(paths.runtimeSecretFileRoot, "openclaw.json");
		const staleSecret = join(paths.runtimeSecretFileRoot, "stale-runtime.json");
		const systemdUnit = join(paths.systemdUserRoot, "clawdi-openclaw.service");
		const installerPath = join(dirname(paths.userHome), "openclaw-installer.sh");
		const installerLog = join(dirname(paths.userHome), "openclaw-installer.log");
		writeFileSync(installerPath, `#!/usr/bin/env bash\necho spawned > '${installerLog}'\nexit 0\n`);
		chmodSync(installerPath, 0o700);
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = installerPath;
		mkdirSync(workspaceRoot, { recursive: true });
		mkdirSync(dirname(paths.managedConfig), { recursive: true });
		mkdirSync(paths.runConfigRoot, { recursive: true });
		mkdirSync(paths.runtimeSecretFileRoot, { recursive: true });
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
		mkdirSync(dirname(paths.appliedState), { recursive: true });
		writeFileSync(soulPath, "<!-- >>> clawdi managed locale >>>\nmalformed\n");
		writeFileSync(paths.managedConfig, '{"generation":1}\n');
		writeFileSync(staleRunConfig, '{"generation":1}\n');
		writeFileSync(runtimeSecret, '{"secret":"old"}\n');
		writeFileSync(staleSecret, '{"secret":"stale"}\n');
		writeFileSync(systemdUnit, "old unit\n");
		writeFileSync(paths.manifestLastGood, '{"generation":1}\n');
		writeFileSync(paths.appliedState, '{"generation":1}\n');
		const preservedPaths = [
			soulPath,
			paths.managedConfig,
			staleRunConfig,
			runtimeSecret,
			staleSecret,
			systemdUnit,
			paths.manifestLastGood,
			paths.appliedState,
		];
		const previous = new Map(preservedPaths.map((path) => [path, readFileSync(path)]));
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					install: {
						authority: "official",
						method: "official-installer",
						url: OFFICIAL_INSTALL_URLS.openclaw,
						home: paths.userHome,
						args: [...OFFICIAL_INSTALL_ARGS.openclaw],
					},
					run: runSettings("openclaw", ["gateway", "run"]),
					services: {},
				},
			},
			{
				generation: 2,
				locale: { language: "en", timezone: "UTC" },
			},
		);

		expect(() =>
			convergeRuntimeManifest(manifestLoad(manifest, "inline-plan-failure"), paths),
		).toThrow(/managed locale block markers are malformed/);
		for (const path of preservedPaths) {
			const expected = previous.get(path);
			if (!expected) throw new Error(`missing preserved fixture for ${path}`);
			expect(readFileSync(path)).toEqual(expected);
		}
		expect(existsSync(installerLog)).toBe(false);
	});

	test("rolls back every live file when an OpenClaw target patch fails", () => {
		const paths = tempRuntimePaths();
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
		const workspaceRoot = join(paths.userHome, "clawdi");
		const commandPath = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const targetConfig = join(paths.userHome, ".openclaw", "openclaw.json");
		const unmanagedState = join(paths.serviceStateRoot, "unmanaged.txt");
		const unmanagedRun = join(paths.runRoot, "unmanaged.txt");
		const unmanagedOpenClaw = join(paths.userHome, ".openclaw", "user-data.txt");
		const unmanagedHermes = join(paths.userHome, ".hermes", "user-data.txt");
		const unmanagedFifo = join(paths.runRoot, "unmanaged.fifo");
		mkdirSync(dirname(commandPath), { recursive: true });
		mkdirSync(workspaceRoot, { recursive: true });
		mkdirSync(dirname(paths.managedConfig), { recursive: true });
		mkdirSync(paths.runConfigRoot, { recursive: true });
		mkdirSync(paths.runtimeSecretFileRoot, { recursive: true });
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		writeFileSync(
			commandPath,
			["#!/usr/bin/env bash", "set -euo pipefail", "cat >/dev/null || true", "exit 42", ""].join(
				"\n",
			),
		);
		chmodSync(commandPath, 0o700);
		for (const path of [unmanagedState, unmanagedRun, unmanagedOpenClaw, unmanagedHermes]) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `unmanaged:${path}\n`);
		}
		execFileSync("mkfifo", [unmanagedFifo]);
		const unmanagedContents = new Map(
			[unmanagedState, unmanagedRun, unmanagedOpenClaw, unmanagedHermes].map((path) => [
				path,
				readFileSync(path),
			]),
		);
		const preservedPaths = [
			paths.managedConfig,
			join(paths.runConfigRoot, "stale.json"),
			join(paths.runtimeSecretFileRoot, "stale.json"),
			join(paths.systemdUserRoot, "clawdi-old.service"),
			targetConfig,
		];
		for (const [index, path] of preservedPaths.entries()) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `old-${index}\n`);
		}
		chmodSync(paths.managedConfig, 0o640);
		const previousManagedStat = statSync(paths.managedConfig);
		const previous = new Map(preservedPaths.map((path) => [path, readFileSync(path)]));
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings(commandPath, ["gateway", "run"]),
					services: {},
				},
			},
			{ locale: { language: "en", timezone: "UTC" } },
		);

		let activateCalls = 0;
		let rollbackCalls = 0;
		const result = convergeRuntimeManifest(manifestLoad(manifest, "inline-patch-failure"), paths, {
			systemdApply: {
				activate: () => {
					activateCalls += 1;
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
				rollback: () => {
					rollbackCalls += 1;
				},
			},
		});

		expect(result.installErrors.join("\n")).toContain(
			"runtime openclaw provider projection failed",
		);
		for (const path of preservedPaths) {
			const expected = previous.get(path);
			if (!expected) throw new Error(`missing preserved fixture for ${path}`);
			expect(readFileSync(path)).toEqual(expected);
		}
		const restoredManagedStat = statSync(paths.managedConfig);
		expect(restoredManagedStat.mode & 0o777).toBe(previousManagedStat.mode & 0o777);
		expect(restoredManagedStat.uid).toBe(previousManagedStat.uid);
		expect(restoredManagedStat.gid).toBe(previousManagedStat.gid);
		for (const [path, expected] of unmanagedContents) {
			expect(readFileSync(path)).toEqual(expected);
		}
		expect(statSync(unmanagedFifo).isFIFO()).toBe(true);
		expect(activateCalls).toBe(0);
		expect(rollbackCalls).toBe(0);
	});

	test("snapshots only the managed systemd drop-in and leaves siblings untouched", () => {
		const paths = tempRuntimePaths();
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
		const workspaceRoot = join(paths.userHome, "clawdi");
		const commandPath = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const dropInRoot = join(paths.systemdUserRoot, "openclaw-gateway.service.d");
		const managedDropIn = join(dropInRoot, "10-clawdi-hosted.conf");
		const siblingDropIn = join(dropInRoot, "50-user.conf");
		const siblingFifo = join(dropInRoot, "60-user.fifo");
		mkdirSync(dirname(commandPath), { recursive: true });
		mkdirSync(workspaceRoot, { recursive: true });
		mkdirSync(dropInRoot, { recursive: true });
		writeFileSync(commandPath, "#!/usr/bin/env bash\ncat >/dev/null || true\nexit 42\n");
		chmodSync(commandPath, 0o700);
		writeFileSync(managedDropIn, `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\nold managed\n`);
		writeFileSync(siblingDropIn, "user-owned\n");
		execFileSync("mkfifo", [siblingFifo]);
		const previousManaged = readFileSync(managedDropIn);
		const previousSibling = readFileSync(siblingDropIn);
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings(commandPath, ["gateway", "run"]),
					services: {},
				},
			},
			{ locale: { language: "en", timezone: "UTC" } },
		);

		const result = convergeRuntimeManifest(manifestLoad(manifest, "inline-dropin-failure"), paths);

		expect(result.installErrors).not.toEqual([]);
		expect(readFileSync(managedDropIn)).toEqual(previousManaged);
		expect(readFileSync(siblingDropIn)).toEqual(previousSibling);
		expect(statSync(siblingFifo).isFIFO()).toBe(true);
	});

	test("uses an explicit managed snapshot allowlist without broad runtime roots", () => {
		const paths = tempRuntimePaths();
		const workspaceRoot = join(paths.userHome, "clawdi");
		const manifest = baseManifest(paths, {
			openclaw: { enabled: true, run: runSettings("openclaw", []), services: {} },
			hermes: { enabled: true, run: runSettings("hermes", []), services: {} },
		});
		const snapshotPaths = runtimeLiveSnapshotPaths(manifest, paths, workspaceRoot);

		expect(snapshotPaths).not.toContain(paths.serviceStateRoot);
		expect(snapshotPaths).not.toContain(paths.runRoot);
		expect(snapshotPaths).not.toContain(paths.userHome);
		expect(snapshotPaths).not.toContain(workspaceRoot);
		expect(snapshotPaths).not.toContain(join(paths.userHome, ".openclaw"));
		expect(snapshotPaths).not.toContain(join(paths.userHome, ".hermes"));
		expect(snapshotPaths).toContain(paths.managedConfig);
		expect(snapshotPaths).toContain(join(paths.userHome, ".openclaw", "openclaw.json"));
		expect(snapshotPaths).toContain(join(paths.userHome, ".hermes", "config.yaml"));
		for (const [index, path] of snapshotPaths.entries()) {
			for (const other of snapshotPaths.slice(index + 1)) {
				expect(other.startsWith(`${path}/`) || path.startsWith(`${other}/`)).toBe(false);
			}
		}
	});

	test("rejects a malformed Hermes MCP patch before Apply", () => {
		const paths = tempRuntimePaths();
		const hermesConfig = join(paths.userHome, ".hermes", "config.yaml");
		mkdirSync(dirname(hermesConfig), { recursive: true });
		mkdirSync(dirname(paths.managedConfig), { recursive: true });
		writeFileSync(hermesConfig, "mcp_servers: []\n");
		writeFileSync(paths.managedConfig, '{"generation":1}\n');
		const previousConfig = readFileSync(hermesConfig);
		const previousManaged = readFileSync(paths.managedConfig);
		const manifest = baseManifest(
			paths,
			{
				hermes: {
					enabled: true,
					run: runSettings("hermes", ["gateway", "run"]),
					services: {},
				},
			},
			{ projection: { mcp: { enabled: true } } },
		);

		expect(() =>
			convergeRuntimeManifest(manifestLoad(manifest, "inline-hermes-patch-failure"), paths),
		).toThrow(/mcp_servers must be a YAML object/);
		expect(readFileSync(hermesConfig)).toEqual(previousConfig);
		expect(readFileSync(paths.managedConfig)).toEqual(previousManaged);
	});

	test("rolls back managed state when the authority commit fails", () => {
		const paths = tempRuntimePaths();
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
		mkdirSync(dirname(paths.managedConfig), { recursive: true });
		mkdirSync(dirname(paths.appliedState), { recursive: true });
		writeFileSync(paths.managedConfig, "old-managed\n");
		writeFileSync(paths.appliedState, "old-applied\n");
		chmodSync(paths.managedConfig, 0o640);
		const previousManaged = readFileSync(paths.managedConfig);
		const previousApplied = readFileSync(paths.appliedState);
		const previousStat = statSync(paths.managedConfig);
		const manifest = baseManifest(paths, {
			openclaw: {
				enabled: true,
				run: runSettings("openclaw", ["gateway", "run"]),
				services: {},
			},
		});

		const result = convergeRuntimeManifest(
			manifestLoad(manifest, "inline-authority-failure"),
			paths,
			{
				cacheLastGood: false,
				commitAuthority: () => {
					writeFileSync(paths.managedConfig, "authority-mutated\n");
					throw new Error("authority commit failed");
				},
			},
		);

		expect(result.installErrors.join("\n")).toContain("authority commit failed");
		expect(readFileSync(paths.managedConfig)).toEqual(previousManaged);
		expect(readFileSync(paths.appliedState)).toEqual(previousApplied);
		const restoredStat = statSync(paths.managedConfig);
		expect(restoredStat.mode & 0o777).toBe(previousStat.mode & 0o777);
		expect(restoredStat.uid).toBe(previousStat.uid);
		expect(restoredStat.gid).toBe(previousStat.gid);
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
