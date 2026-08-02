import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { commitRuntimeAppliedState } from "../commands/runtime";
import {
	readRuntimeAppliedState,
	runtimeContentSha256,
	writeRuntimeAppliedState,
} from "./applied-state";
import { MANAGED_EGRESS_PLACEHOLDER_VALUE } from "./egress-env";
import { loadHostedBundledSkill } from "./hosted-bundled-skill";
import { hostedManifestEgressProfiles } from "./hosted-egress-profiles";
import {
	hostedAiProviderCatalog,
	resolveManagedGatewayModelOverrides,
} from "./hosted-provider-resolution";
import {
	captureRuntimeLiveSnapshot,
	restoreRuntimeLiveSnapshot,
	runtimeRootLiveMutationTargets,
} from "./live-state-snapshot";
import {
	cacheRuntimeLastGoodManifest,
	convergeRuntimeManifest,
	type RuntimeManifest,
	runtimeInstallerMutationTargets,
	runtimeRecoverableSecretValues,
	runtimeUserMutationTargets,
} from "./manifest";
import {
	hostedRuntimeBundleV2ManifestSchema,
	hostedRuntimeManifestFixtureResponseSchema,
	hostedRuntimeManifestResponseSchema,
	hostedRuntimeManifestSchema,
	manifestSchema,
	OFFICIAL_INSTALL_ARGS,
	OFFICIAL_INSTALL_URLS,
} from "./manifest-contract";
import {
	hostedManifestToRuntimeManifest,
	loadCommittedRuntimeManifest,
	type RuntimeManifestLoad,
} from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { type RuntimeRunSettings, runtimeRunConfigPath } from "./run-config";
import { normalizeSecretValues, runtimeSecretValue } from "./secret-values";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";

const successfulPrerequisiteActivation = () => ({
	applied: true,
	systemUnitsChanged: [],
	userUnitsChanged: [],
});

const originalEnv = { ...process.env };
const tempRoots: string[] = [];
const TEST_HOSTED_LOCALE = { language: "en" as const, timezone: "UTC" };
const TEST_HOSTED_MINIMUM_CLI_VERSION = "0.12.10-beta.57";
const TEST_HOSTED_HOME = "/home/clawdi";
const TEST_HOSTED_SECRET_VALUES = {
	"secret://clawdi/auth-token": "test-auth-token",
	"secret://runtime/openclaw/gateway-token": "gateway-token",
	"secret://tool.codex.apiKey": "test-codex-provider-key",
};
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
			apiKeySecretRef: "secret://tool.codex.apiKey",
		},
	},
};

function hostedSystemFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		openclawControlUiAllowedOrigins: ["https://agent.example.test"],
		openclawControlUiBasePath: "/control",
		openclawGatewayAuth: hostedOpenClawNativeAuth(),
		...overrides,
	};
}

function hostedOpenClawNativeAuth(
	publicUrl = "https://agent.example.test/control",
): NonNullable<RuntimeManifest["openclawGatewayAuth"]> {
	void publicUrl;
	return {
		mode: "token",
		tokenRef: "secret://runtime/openclaw/gateway-token",
		deviceAuthRequired: false,
		activation: {
			enabled: true,
			capability: "openclaw-native-auth-v1",
		},
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
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
	return getRuntimePaths({ mode: "hosted" });
}

function runSettings(command: string, args: string[]): RuntimeRunSettings {
	return { command, args, env: {}, prependPath: [] };
}

function manifestLoad(
	manifest: RuntimeManifest,
	sourcePath: string,
	secretValues: Record<string, string> = TEST_HOSTED_SECRET_VALUES,
): RuntimeManifestLoad {
	return {
		manifest,
		source: "remote-datasource",
		sourcePath,
		offline: false,
		secretValues,
		applyContext: {
			kind: "context-file",
			identity: {
				generation: manifest.applyGeneration ?? manifest.generation,
				manifestETag: `"test-${manifest.generation}"`,
				applyReceiptId: "test-apply-receipt",
				bootNonce: "test-boot-nonce",
			},
			cliPackageSpec: "clawdi@1.2.3",
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env-test",
				auth: { type: "bearer", token: "test-token" },
			},
		},
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

function testEgressEnginePin(
	version: string,
	sha256: string,
): NonNullable<RuntimeManifest["egressEngine"]> {
	return {
		type: "mitmproxy",
		version,
		url: `https://downloads.mitmproxy.org/${version}/mitmproxy-${version}-linux-x86_64.tar.gz`,
		sha256,
	};
}

function installCachedTestEgressEngine(paths: RuntimePaths, version: string) {
	const engine = testEgressEnginePin(version, "a".repeat(64));
	const binaryPath = join(paths.egressEngineMaintainedRoot, version, engine.sha256, "mitmdump");
	mkdirSync(dirname(binaryPath), { recursive: true });
	writeFileSync(binaryPath, "#!/usr/bin/env sh\nexit 0\n");
	chmodSync(binaryPath, 0o755);
	return engine;
}

function writeTestMitmproxyArchive(
	paths: RuntimePaths,
	name: string,
	kind: "ready" | "missing-mitmdump" | "corrupt",
): { path: string; sha256: string } {
	const fixtureRoot = join(dirname(paths.serviceStateRoot), "egress-engine-fixtures", name);
	const archivePath = join(fixtureRoot, `${name}.tar.gz`);
	mkdirSync(fixtureRoot, { recursive: true });
	if (kind === "corrupt") {
		writeFileSync(archivePath, "not a tar.gz archive\n");
	} else {
		const sourceRoot = join(fixtureRoot, "source", `mitmproxy-${name}`);
		mkdirSync(sourceRoot, { recursive: true });
		if (kind === "ready") {
			const binaryPath = join(sourceRoot, "mitmdump");
			writeFileSync(binaryPath, "#!/usr/bin/env sh\nexit 0\n");
			chmodSync(binaryPath, 0o755);
		} else {
			writeFileSync(join(sourceRoot, "README.txt"), "mitmdump intentionally absent\n");
		}
		execFileSync("tar", ["-czf", archivePath, "-C", join(fixtureRoot, "source"), "."]);
	}
	return {
		path: archivePath,
		sha256: createHash("sha256").update(readFileSync(archivePath)).digest("hex"),
	};
}

function installTestMitmproxyCurl(
	paths: RuntimePaths,
	artifactPath: string | null,
): { commandPath: string; markerPath: string } {
	const binRoot = join(dirname(paths.serviceStateRoot), "egress-engine-test-bin");
	const curlPath = join(binRoot, "curl");
	const markerPath = join(binRoot, "curl-invoked");
	mkdirSync(binRoot, { recursive: true });
	writeFileSync(
		curlPath,
		artifactPath
			? [
					"#!/usr/bin/env bash",
					"set -euo pipefail",
					`printf invoked > ${JSON.stringify(markerPath)}`,
					`cp -- ${JSON.stringify(artifactPath)} "$5"`,
					"",
				].join("\n")
			: [
					"#!/usr/bin/env bash",
					"set -euo pipefail",
					`printf invoked > ${JSON.stringify(markerPath)}`,
					"printf 'artifact endpoint unavailable: test-token\\n' >&2",
					"exit 22",
					"",
				].join("\n"),
	);
	chmodSync(curlPath, 0o700);
	return { commandPath: curlPath, markerPath };
}

function egressRuntimeManifest(
	paths: RuntimePaths,
	input: {
		generation: number;
		engine?: RuntimeManifest["egressEngine"];
		profile: "enabled" | "disabled" | "absent";
	},
): RuntimeManifest {
	process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
	const commandPath = join(paths.userHome, ".openclaw", "bin", "openclaw");
	mkdirSync(dirname(commandPath), { recursive: true });
	writeFileSync(commandPath, "#!/usr/bin/env sh\nexit 0\n");
	chmodSync(commandPath, 0o700);
	return baseManifest(
		paths,
		{
			openclaw: {
				enabled: true,
				run: runSettings(commandPath, ["gateway", "run"]),
				services: {},
			},
		},
		{
			generation: input.generation,
			issuedAt: `2026-07-01T00:0${input.generation}:00.000Z`,
			openclawGatewayAuth: hostedOpenClawNativeAuth(),
			projection: {
				sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
				system: hostedSystemFixture(),
			},
			...(input.engine ? { egressEngine: input.engine } : {}),
			...(input.profile === "absent"
				? {}
				: {
						egressProfiles: {
							profiles: [
								{
									id: "required-egress",
									enabled: input.profile === "enabled",
									kind: "http" as const,
									match: {
										scheme: "https" as const,
										host: "api.example.test",
										headers: {},
										query: {},
									},
									rewrite: {
										upstreamBaseUrl: "https://upstream.example.test",
										preservePath: true,
										setHeaders: {},
									},
									logging: { redactHeaders: [], redactUrlPatterns: [] },
									priority: 100,
								},
							],
						},
					}),
		},
	);
}

function commitTestRuntimeAuthority(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	convergence: ReturnType<typeof convergeRuntimeManifest>,
	authority: { egressSidecarSecretRevision?: string },
): void {
	commitRuntimeAppliedState({
		load,
		paths,
		etag: `"generation-${load.manifest.generation}"`,
		sourceRevision: runtimeContentSha256({ generation: load.manifest.generation }),
		convergence,
		applyIdentity: null,
		egressSidecarSecretRevision: authority.egressSidecarSecretRevision,
	});
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
			packageSpec: "clawdi@0.12.10-beta.57",
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
				run: {
					args: [
						"gateway",
						"run",
						"--allow-unconfigured",
						"--port",
						"18789",
						"--bind",
						"lan",
						"--force",
					],
					secretEnv: {
						OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
					},
				},
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
		run: {
			args: [
				"gateway",
				"run",
				"--allow-unconfigured",
				"--port",
				"18789",
				"--bind",
				"lan",
				"--force",
			],
			secretEnv: {
				OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
			},
		},
		...overrides,
	};
}

function hostedHermesManifestFixture(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return hostedManifestFixture({
		runtime: "hermes",
		system: {
			hermesDashboardAuth: {
				mode: "password",
				provider: "basic",
				username: "admin",
				passwordSecretRef: "secret://runtime/hermes/dashboard-password",
				sessionSecretRef: "secret://runtime/hermes/dashboard-session-secret",
				sessionTtlSeconds: 43_200,
				publicUrl: "https://agent.example.test/hermes",
				activation: {
					enabled: true,
					capability: "hermes-basic-auth-v1",
				},
			},
		},
		runtimes: {
			hermes: hostedRuntimeFixture({
				run: undefined,
				services: {
					dashboard: {
						args: ["dashboard", "--host", "0.0.0.0", "--port", "9119", "--no-open"],
					},
				},
			}),
		},
		...overrides,
	});
}

function hostedOpenClawV2ManifestFixture(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const publicUrl = "https://agent.example.test/control";
	return hostedManifestFixture({
		schemaVersion: "clawdi.hosted-runtime.manifest.v1",
		system: hostedSystemFixture({
			openclawControlUiAllowedOrigins: ["https://agent.example.test"],
			openclawControlUiBasePath: "/control",
			openclawGatewayAuth: hostedOpenClawNativeAuth(publicUrl),
		}),
		runtimes: {
			openclaw: hostedRuntimeFixture({
				run: {
					command: "openclaw",
					args: [
						"gateway",
						"run",
						"--allow-unconfigured",
						"--port",
						"18789",
						"--bind",
						"lan",
						"--force",
					],
					env: {},
					secretEnv: {
						OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
					},
					prependPath: [],
				},
			}),
		},
		...overrides,
	});
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
	test.each([
		["OpenClaw", hostedOpenClawV2ManifestFixture()],
		["Hermes", hostedHermesManifestFixture()],
	] as const)("rejects the removed bridge field in every hosted %s manifest schema", (_name, valid) => {
		expect(hostedRuntimeManifestSchema.safeParse(valid).success).toBe(true);
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(valid).success).toBe(true);
		const withBridge = { ...valid, bridge: {} };
		expect(hostedRuntimeManifestSchema.safeParse(withBridge).success).toBe(false);
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(withBridge).success).toBe(false);
		expect(
			hostedRuntimeManifestResponseSchema.safeParse({
				manifest: withBridge,
				secretValues: {},
			}).success,
		).toBe(false);
	});

	test("requires typed native token auth for hosted OpenClaw v2", () => {
		const valid = hostedOpenClawV2ManifestFixture();
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(valid).success).toBe(true);

		const missingAuth = structuredClone(valid);
		delete (missingAuth.system as { openclawGatewayAuth?: unknown }).openclawGatewayAuth;
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(missingAuth).success).toBe(false);

		const inactive = structuredClone(valid);
		(
			inactive.system as { openclawGatewayAuth: { activation: { enabled: boolean } } }
		).openclawGatewayAuth.activation.enabled = false;
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(inactive).success).toBe(false);

		const mismatchedOrigin = structuredClone(valid);
		(
			mismatchedOrigin.system as { openclawControlUiAllowedOrigins: string[] }
		).openclawControlUiAllowedOrigins = ["https://other.example.test"];
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(mismatchedOrigin).success).toBe(true);

		const serviceGatewayTokenEnvironment = structuredClone(valid);
		(
			serviceGatewayTokenEnvironment.runtimes as {
				openclaw: { services: Record<string, unknown> };
			}
		).openclaw.services = {
			helper: {
				secretEnv: { OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token" },
			},
		};
		expect(
			hostedRuntimeBundleV2ManifestSchema.safeParse(serviceGatewayTokenEnvironment).success,
		).toBe(false);
	});
	test("requires official Basic auth and direct 9119 exposure for hosted Hermes v2", () => {
		const valid = hostedHermesManifestFixture();
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(valid).success).toBe(true);
		expect(
			hostedRuntimeBundleV2ManifestSchema.safeParse({
				...valid,
				system: hostedSystemFixture(),
			}).success,
		).toBe(false);
		const inactive = structuredClone(valid);
		(
			inactive.system as { hermesDashboardAuth: { activation: { enabled: boolean } } }
		).hermesDashboardAuth.activation.enabled = false;
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(inactive).success).toBe(false);
	});
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
								max_input_tokens: 1_048_576,
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
					max_input_tokens: 1_048_576,
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
			{ run: { secretEnv: { OPENAI_API_KEY: "secret://provider.clawdi-managed-v2.apiKey" } } },
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
			services: { helper: { secretEnv: { TOKEN: "secret://vault/default/key" } } },
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
			apiKeySecretRef: "secret://provider.default.apiKey",
		};
		const manifest = hostedManifestFixture({ providers: { default: provider } });

		expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(false);
	});

	test("rejects terminal Codex with a runtime-provider secret ref", () => {
		const terminalTooling = structuredClone(TEST_HOSTED_CODEX_TOOLING);
		terminalTooling.codex.provider.apiKeySecretRef = "secret://provider.codex-managed.apiKey";
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
		"secret://provider.stale.apiKey",
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
		["multiple provider_ids", { provider_ids: ["default", "secondary"] }],
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

	test("rejects rather than strips the removed bridge field in generic manifests", () => {
		const paths = tempRuntimePaths();
		const valid = baseManifest(paths, {
			openclaw: {
				enabled: true,
				run: runSettings("openclaw", ["gateway", "run"]),
				services: {},
			},
		});
		const result = manifestSchema.safeParse({ ...valid, bridge: {} });

		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected removed bridge field rejection");
		expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["bridge"] }));
	});

	test("accepts independent positive checkpoint and apply generations at the shared boundary", () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(paths, {
			openclaw: {
				enabled: true,
				run: runSettings("openclaw", ["gateway", "run"]),
				services: {},
			},
		});

		const result = manifestSchema.safeParse({
			...manifest,
			generation: 2,
			applyGeneration: 3,
		});

		expect(result.success).toBe(true);
		if (!result.success) throw result.error;
		expect(result.data.generation).toBe(2);
		expect(result.data.applyGeneration).toBe(3);
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
		["api_key_secret_ref", { api_key_secret_ref: "secret://provider.default.apiKey" }],
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
				apiKeySecretRef: "secret://provider.default.apiKey",
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
		process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
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
					openclaw: hostedRuntimeFixture(),
				},
			}),
		);
		const normalized: RuntimeManifest = {
			...hostedManifestToRuntimeManifest(hosted),
			egressEngine: installCachedTestEgressEngine(paths, "12.2.3-test-control-ui"),
		};
		expect(normalized.projection?.system).toEqual(hosted.system);

		const result = convergeRuntimeManifest(
			manifestLoad(normalized, "inline-hosted-control-ui-origins"),
			paths,
		);

		expect(result.installErrors).toEqual([]);
		expect(JSON.parse(readFileSync(patchPath, "utf8"))).toMatchObject({
			gateway: {
				port: 18789,
				bind: "lan",
				auth: { mode: "token", token: null },
				controlUi: {
					allowedOrigins,
					allowInsecureAuth: false,
					dangerouslyAllowHostHeaderOriginFallback: false,
					dangerouslyDisableDeviceAuth: true,
				},
			},
		});
	});

	test("projects hosted OpenClaw v2 direct token auth with device auth disabled", () => {
		const paths = tempRuntimePaths();
		const openclawBin = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const patchPath = join(paths.serviceStateRoot, "openclaw-native-auth-patch.json");
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

		const hosted = hostedRuntimeBundleV2ManifestSchema.parse(hostedOpenClawV2ManifestFixture());
		const projected = hostedManifestToRuntimeManifest(hosted);
		const normalized: RuntimeManifest = {
			...projected,
			egressEngine: installCachedTestEgressEngine(paths, "12.2.3-test-native-auth"),
			projection: {
				...projected.projection,
				sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
			},
		};
		expect(() =>
			convergeRuntimeManifest(
				manifestLoad(normalized, "inline-hosted-openclaw-native-auth-missing-token", {}),
				paths,
			),
		).toThrow("Runtime secret secret://runtime/openclaw/gateway-token is unavailable");
		expect(existsSync(patchPath)).toBe(false);
		const result = convergeRuntimeManifest(
			manifestLoad(normalized, "inline-hosted-openclaw-native-auth", {
				"secret://runtime/openclaw/gateway-token": "gateway-token",
				"secret://tool.codex.apiKey": "test-codex-provider-key",
			}),
			paths,
		);

		expect(result.installErrors).toEqual([]);
		const gatewayPatch = JSON.parse(readFileSync(patchPath, "utf8"));
		expect(gatewayPatch).toMatchObject({
			gateway: {
				port: 18789,
				bind: "lan",
				auth: {
					mode: "token",
					token: null,
				},
				controlUi: {
					basePath: "/control",
					allowedOrigins: ["https://agent.example.test"],
					allowInsecureAuth: false,
					dangerouslyAllowHostHeaderOriginFallback: false,
					dangerouslyDisableDeviceAuth: true,
				},
			},
		});
		expect(JSON.stringify(gatewayPatch)).not.toContain("gateway-token");
		const gatewayEnv = readFileSync(
			join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
			"utf8",
		);
		expect(gatewayEnv).toContain('OPENCLAW_GATEWAY_TOKEN="gateway-token"');
		expect(result.outputs.systemdSystemUnits.map((path) => path.split("/").at(-1))).toContain(
			"clawdi-runtime-sidecar.service",
		);
	});

	test("rejects hosted manifests without an explicit CLI package policy", () => {
		expect(() =>
			hostedRuntimeManifestResponseSchema.parse({
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
				packageSpec: "clawdi@0.12.10-beta.57",
				registry: "https://registry.npmjs.org",
			},
		},
		{
			name: "missing registry",
			clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@0.12.10-beta.57" },
		},
		{
			name: "non-official registry",
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@0.12.10-beta.57",
				registry: "https://registry.example.test",
			},
		},
		{
			name: "dead managed flags",
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@0.12.10-beta.57",
				registry: "https://registry.npmjs.org",
				managedConfig: true,
				userEditableConfig: false,
			},
		},
	])("rejects hosted CLI policy with $name", ({ clawdiCli }) => {
		expect(() =>
			hostedRuntimeManifestResponseSchema.parse({
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
		"clawdi@0.12.10-beta.57",
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

	test("rejects raw secretValues keys in the Hosted fixture contract", () => {
		expect(
			hostedRuntimeManifestFixtureResponseSchema.safeParse({
				manifest: hostedManifestFixture(),
				secretValues: { "tool.codex.apiKey": "must-be-rejected" },
			}).success,
		).toBe(false);
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
		"/usr/local/share/clawdi/bootstrap/clawdi-0.12.10-beta.57.tgz",
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
					packageSpec: "clawdi@0.12.10-beta.57",
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
								"--port",
								"18789",
								"--bind",
								"lan",
								"--force",
							],
							env: { OPENCLAW_TEST: "1" },
							secretEnv: {
								OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
							},
							prependPath: [],
						},
					},
				},
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
				"secret://providers/default/api-key": "sk-normalized",
			},
		};

		const parsedResponse = hostedRuntimeManifestResponseSchema.parse(hostedResponse);
		const hostedManifest = hostedRuntimeManifestSchema.parse(parsedResponse.manifest);
		const normalized = {
			manifest: hostedManifestToRuntimeManifest(hostedManifest),
			secretValues: normalizeSecretValues(parsedResponse.secretValues),
		};
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
			"--port",
			"18789",
			"--bind",
			"lan",
			"--force",
		]);
		expect(normalized.manifest.runtimes.openclaw.run?.secretEnv).toEqual({
			OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
		});
		expect(normalized.manifest.projection?.providers).toEqual(hostedResponse.manifest.providers);
		expect(normalized.manifest.egressProfiles?.profiles.map((profile) => profile.id)).toContain(
			"api-proxy",
		);
		expect(normalized.manifest.liveSync).toEqual(hostedResponse.manifest.liveSync);
		expect("secretValues" in normalized.manifest).toBe(false);
		expect(normalized.secretValues).toEqual({
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
					packageSpec: "clawdi@0.12.10-beta.57",
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
				packageSpec: "clawdi@0.12.10-beta.57",
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
					packageSpec: "clawdi@0.12.10-beta.57",
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
			}),
		).toThrow("hosted runtime manifests must declare exactly one selected runtime");
	});

	test("converges OpenClaw native token auth from canonical bundle secret refs", () => {
		const paths = tempRuntimePaths();
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
							OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
						},
						prependPath: [],
					},
					services: {},
				},
			},
			{ runtime: "openclaw" },
		);

		const secretValues = {
			"secret://runtime/openclaw/gateway-token": "gateway-token",
		};
		const result = convergeRuntimeManifest(
			manifestLoad(manifest, "inline-openclaw", secretValues),
			paths,
		);

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
			OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
		});
		expect(runConfig.secretFilePath).toBeNull();
		expect(runtimeSecretValue(secretValues, "secret://runtime/openclaw/gateway-token")).toBe(
			"gateway-token",
		);
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

	test("replaces the selected Hermes provider with secret refs and stale cleanup", () => {
		const paths = tempRuntimePaths();
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		const hermesConfig = join(paths.userHome, ".hermes", "config.yaml");
		const legacyPlugin = join(
			paths.userHome,
			".hermes",
			"plugins",
			"model-providers",
			"clawdi",
			"__init__.py",
		);
		const responsesKey = "sentinel-responses-runtime";
		const anthropicKey = "sentinel-anthropic-runtime";
		mkdirSync(dirname(hermesCommand), { recursive: true });
		mkdirSync(dirname(legacyPlugin), { recursive: true });
		writeFileSync(hermesCommand, "#!/bin/sh\nexit 0\n");
		writeFileSync(legacyPlugin, 'raise RuntimeError("obsolete")\n');
		writeFileSync(
			hermesConfig,
			[
				"model:",
				"  provider: responses",
				"providers:",
				"  responses:",
				"    api: https://stale.example.test/v1",
				"    api_key: stale-inline-secret",
				"",
			].join("\n"),
		);
		chmodSync(hermesCommand, 0o700);

		const providerEntries = {
			responses: {
				type: "openai",
				baseUrl: "https://responses.example.test/v1",
				apiMode: "openai_responses",
				models: [{ id: "gpt-test" }],
				runtimeEnvName: "RESPONSES_API_KEY",
				apiKeySecretRef: "secret://providers/responses/api-key",
			},
			anthropic: {
				type: "anthropic",
				baseUrl: "https://anthropic.example.test",
				apiMode: "anthropic_messages",
				models: [{ id: "claude-test" }],
				runtimeEnvName: "ANTHROPIC_TEST_API_KEY",
				apiKeySecretRef: "secret://providers/anthropic/api-key",
			},
		};
		const manifestFor = (
			providers: Record<string, unknown>,
			primaryModel: { provider_id: string; model: string } | undefined,
			generation: number,
		): RuntimeManifest =>
			baseManifest(
				paths,
				{
					hermes: {
						enabled: true,
						run: runSettings(hermesCommand, ["gateway", "run"]),
						provider_ids: Object.keys(providers),
						primary_model: primaryModel,
						services: {},
					},
				},
				{
					runtime: "hermes",
					generation,
					issuedAt: `2026-07-01T00:0${generation}:00.000Z`,
					projection: { system: { home: paths.userHome }, providers },
				},
			);
		const writeAppliedProviders = (generation: number, providerIds: string[]) => {
			writeRuntimeAppliedState(
				{
					schemaVersion: "clawdi.runtimeAppliedState.v2",
					appliedAt: `2026-07-01T00:1${generation}:00.000Z`,
					instanceId: "hri_reconcile",
					etag: `"generation-${generation}"`,
					sourceRevision: String(generation).repeat(64),
					generation,
					contentIdentity: {
						sourcePath: `inline-hermes-generation-${generation}`,
						sha256: "a".repeat(64),
					},
					providerIds,
					projectedProviderIds: { hermes: providerIds },
				},
				paths,
			);
		};

		const initial = convergeRuntimeManifest(
			manifestLoad(
				manifestFor(
					{ responses: providerEntries.responses },
					{ provider_id: "responses", model: "gpt-test" },
					1,
				),
				"inline-hermes-native-providers",
				{ "secret://providers/responses/api-key": responsesKey },
			),
			paths,
		);

		expect(initial.installErrors).toEqual([]);
		expect(initial.projectedProviderIds.hermes).toEqual(["responses"]);
		expect(existsSync(dirname(legacyPlugin))).toBe(false);
		const initialConfig = readFileSync(hermesConfig, "utf8");
		const initialRunConfig = readFileSync(runtimeRunConfigPath("hermes", paths), "utf8");
		const initialHermes = parseYaml(initialConfig) as {
			model?: { default?: string; provider?: string };
			providers?: Record<string, unknown>;
		};
		expect(initialHermes.model).toMatchObject({
			default: "gpt-test",
			provider: "custom:responses",
		});
		expect(initialHermes.providers?.responses).toMatchObject({
			api: "https://responses.example.test/v1",
			key_env: "RESPONSES_API_KEY",
			models: { "gpt-test": {} },
			transport: "codex_responses",
		});
		expect(JSON.parse(initialRunConfig)).toMatchObject({
			secretEnv: {
				RESPONSES_API_KEY: "secret://providers/responses/api-key",
			},
		});
		expect(initialConfig).not.toContain(responsesKey);
		expect(initialRunConfig).not.toContain(responsesKey);
		expect(initialConfig).not.toContain("stale-inline-secret");
		expect(initialConfig).not.toContain("https://stale.example.test/v1");

		writeAppliedProviders(1, initial.projectedProviderIds.hermes ?? []);
		const switched = convergeRuntimeManifest(
			manifestLoad(
				manifestFor(
					{ anthropic: providerEntries.anthropic },
					{ provider_id: "anthropic", model: "claude-test" },
					2,
				),
				"inline-hermes-provider-switch",
				{ "secret://providers/anthropic/api-key": anthropicKey },
			),
			paths,
		);
		expect(switched.installErrors).toEqual([]);
		expect(switched.projectedProviderIds.hermes).toEqual(["anthropic"]);
		const switchedConfig = readFileSync(hermesConfig, "utf8");
		const switchedProviders = (parseYaml(switchedConfig) as { providers?: Record<string, unknown> })
			.providers;
		expect(switchedProviders).not.toHaveProperty("responses");
		expect(parseYaml(switchedConfig)).toMatchObject({
			model: { default: "claude-test", provider: "custom:anthropic" },
			providers: {
				anthropic: {
					api: "https://anthropic.example.test",
					key_env: "ANTHROPIC_TEST_API_KEY",
					models: { "claude-test": {} },
					transport: "anthropic_messages",
				},
			},
		});

		writeAppliedProviders(2, switched.projectedProviderIds.hermes ?? []);
		const deleted = convergeRuntimeManifest(
			manifestLoad(manifestFor({}, undefined, 3), "inline-hermes-provider-delete"),
			paths,
		);
		expect(deleted.installErrors).toEqual([]);
		expect(deleted.projectedProviderIds.hermes).toEqual([]);
		const deletedProviders = (
			parseYaml(readFileSync(hermesConfig, "utf8")) as { providers?: Record<string, unknown> }
		).providers;
		expect(deletedProviders).not.toHaveProperty("anthropic");
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
									max_input_tokens: 1_048_576,
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
				max_input_tokens: 1_048_576,
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

		let probeCalls = 0;
		const overrides = resolveManagedGatewayModelOverrides(
			manifest,
			["openclaw"],
			paths.userHome,
			manifest.workspaceRoot ?? paths.workspaceRoot,
			null,
			() => {
				probeCalls += 1;
				return {
					status: "ok",
					endpoint: "https://api.example.test/v1/models",
					models: [{ id: "unexpected-live-model" }],
				};
			},
		);
		const projection = hostedAiProviderCatalog(manifest, "openclaw", {
			managedModelsOverride: overrides.models.openclaw,
		});
		expect(probeCalls).toBe(0);
		expect(overrides).toEqual({ models: {} });
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

	test("keeps the configured primary while merging a nonempty discovered catalog", () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings("openclaw", ["gateway", "run"]),
					provider_ids: ["default"],
					primary_model: { provider_id: "default", model: "configured-seed" },
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
									id: "configured-seed",
									context_window: 1_048_576,
									max_input_tokens: 1_048_576,
									supports_tools: true,
								},
								{
									id: "kimi-for-coding",
									context_window: 262_144,
									max_input_tokens: 262_144,
									supports_tools: true,
								},
								{
									id: "kimi-for-coding-highspeed",
									context_window: 262_144,
									max_input_tokens: 262_144,
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
			managedModelsOverride: [
				{ id: "kimi-for-coding" },
				{
					id: "kimi-for-coding-highspeed",
					context_window: 262_144,
					max_input_tokens: 262_144,
					supports_tools: true,
				},
			],
		});
		expect(projection?.primaryModel).toEqual({
			provider_id: "default",
			model: "configured-seed",
		});
		expect(projection?.catalog.providers[0]?.models).toEqual([
			{
				id: "configured-seed",
				context_window: 1_048_576,
				max_input_tokens: 1_048_576,
				supports_tools: true,
			},
			{
				id: "kimi-for-coding",
				context_window: 262_144,
				max_input_tokens: 262_144,
				supports_tools: true,
			},
			{
				id: "kimi-for-coding-highspeed",
				context_window: 262_144,
				max_input_tokens: 262_144,
				supports_tools: true,
			},
		]);
	});

	test("uses live managed models only when discovery succeeds with a nonempty catalog", () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings("openclaw", ["gateway", "run"]),
					provider_ids: ["clawdi"],
					primary_model: { provider_id: "clawdi", model: "configured-seed" },
					services: {},
				},
			},
			{
				projection: {
					providers: {
						clawdi: {
							type: "custom_openai_compatible",
							managed_by: "clawdi",
							baseUrl: "https://api.example.test/v1",
							apiMode: "openai_chat",
							models: [{ id: "configured-seed" }, { id: "manifest-secondary" }],
							apiKeySecretRef: "secret://providers/clawdi/api-key",
						},
					},
				},
			},
		);
		const previousWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
		try {
			for (const outcome of ["success", "empty", "failure"] as const) {
				warnings.length = 0;
				const overrides = resolveManagedGatewayModelOverrides(
					manifest,
					["openclaw"],
					paths.userHome,
					manifest.workspaceRoot ?? paths.workspaceRoot,
					null,
					() =>
						outcome === "failure"
							? {
									status: "failed",
									endpoint: "https://api.example.test/v1/models",
									detail: "unavailable",
								}
							: {
									status: "ok",
									endpoint: "https://api.example.test/v1/models",
									models: outcome === "success" ? [{ id: "live-one" }, { id: "live-two" }] : [],
								},
				);
				const projection = hostedAiProviderCatalog(manifest, "openclaw", {
					managedModelsOverride: overrides.models.openclaw,
				});
				expect(projection?.primaryModel).toEqual({
					provider_id: "clawdi",
					model: "configured-seed",
				});
				expect(projection?.catalog.providers[0]?.models?.map((model) => model.id)).toEqual(
					outcome === "success"
						? ["configured-seed", "live-one", "live-two"]
						: ["configured-seed", "manifest-secondary"],
				);
				if (outcome === "failure") {
					expect(warnings).toEqual([
						"managed model probe failed for openclaw/clawdi at https://api.example.test/v1/models: unavailable; keeping configured catalog and default",
					]);
					expect(warnings[0]).not.toMatch(/upgrade|fallback/i);
				} else {
					expect(warnings).toEqual([]);
				}
			}
		} finally {
			console.warn = previousWarn;
		}
	});

	test.each([
		["network", "failed to download mitmproxy"],
		["sha-mismatch", "checksum mismatch"],
		["corrupt-archive", "tar failed to extract mitmproxy"],
		["missing-mitmdump", "archive did not contain mitmdump"],
		["activation", "injected egress activation failure"],
	] as const)("fails closed and preserves authority on first-install and upgrade %s failure", (failure, expectedError) => {
		const prepareFailure = (paths: RuntimePaths, phase: "first" | "upgrade") => {
			const version = `12.2.3-test-${failure}-${phase}`;
			if (failure === "network") {
				const curl = installTestMitmproxyCurl(paths, null);
				return {
					engine: testEgressEnginePin(version, "a".repeat(64)),
					downloadCommand: curl.commandPath,
				};
			}
			const kind =
				failure === "corrupt-archive"
					? "corrupt"
					: failure === "missing-mitmdump"
						? "missing-mitmdump"
						: "ready";
			const artifact = writeTestMitmproxyArchive(paths, `${failure}-${phase}`, kind);
			const curl = installTestMitmproxyCurl(paths, artifact.path);
			return {
				engine: testEgressEnginePin(
					version,
					failure === "sha-mismatch" ? "0".repeat(64) : artifact.sha256,
				),
				downloadCommand: curl.commandPath,
			};
		};
		const hooks = (rollback: () => void, failActivation: boolean) => ({
			activateEgressPrerequisite: successfulPrerequisiteActivation,
			activate: () => {
				if (failActivation) throw new Error("injected egress activation failure");
				return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
			},
			rollback,
		});
		const managedStatePaths = (paths: RuntimePaths) => [
			paths.managedConfig,
			paths.syncState,
			paths.egressEngineStatus,
			paths.manifestLastGood,
			paths.managedSecretCacheFile,
			paths.appliedState,
			paths.egressProfileBundle,
			join(paths.managedSecretRoot, "egress-secrets.json"),
			paths.egressAddon,
			paths.egressTransparentEnv,
			paths.egressSystemCaFile,
			join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"),
			join(paths.systemdEnvRoot, "clawdi-runtime-sidecar.service.env"),
		];
		const capture = (paths: readonly string[]) =>
			new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path, "utf-8") : null]));
		const expectSnapshot = (snapshot: Map<string, string | null>) => {
			for (const [path, expected] of snapshot) {
				if (expected === null) expect(existsSync(path)).toBe(false);
				else expect(readFileSync(path, "utf-8")).toBe(expected);
			}
		};

		const firstPaths = tempRuntimePaths();
		const firstSnapshot = capture(managedStatePaths(firstPaths));
		const firstFailure = prepareFailure(firstPaths, "first");
		const firstManifest = egressRuntimeManifest(firstPaths, {
			generation: 1,
			engine: firstFailure.engine,
			profile: "enabled",
		});
		const firstLoad = manifestLoad(firstManifest, `inline-egress-${failure}-first`);
		let firstCommits = 0;
		const failedFirstInstall = convergeRuntimeManifest(firstLoad, firstPaths, {
			cacheLastGood: false,
			commitAuthority: (convergence, authority) => {
				firstCommits += 1;
				commitTestRuntimeAuthority(firstLoad, firstPaths, convergence, authority);
			},
			egressEngineEnsureOptions: { downloadCommand: firstFailure.downloadCommand },
			systemdApply: hooks(() => {}, failure === "activation"),
		});
		const firstErrors = failedFirstInstall.installErrors.join("\n");
		expect(firstErrors).toContain(expectedError);
		if (failure !== "activation") {
			expect(firstErrors).toStartWith(
				"runtime apply failed: required egress engine is not ready: ",
			);
		}
		expect(firstErrors).not.toContain("test-token");
		expect(firstCommits).toBe(0);
		expectSnapshot(firstSnapshot);
		expect(existsSync(runtimeRunConfigPath("openclaw", firstPaths))).toBe(false);
		expect(existsSync(firstPaths.manifestLastGood)).toBe(false);
		expect(existsSync(firstPaths.appliedState)).toBe(false);

		const upgradePaths = tempRuntimePaths();
		const baselineArtifact = writeTestMitmproxyArchive(
			upgradePaths,
			`baseline-${failure}`,
			"ready",
		);
		const baselineCurl = installTestMitmproxyCurl(upgradePaths, baselineArtifact.path);
		const baselineManifest = egressRuntimeManifest(upgradePaths, {
			generation: 1,
			engine: testEgressEnginePin(`12.2.3-test-baseline-${failure}`, baselineArtifact.sha256),
			profile: "enabled",
		});
		const baselineLoad = manifestLoad(baselineManifest, `inline-egress-${failure}-baseline`);
		const baseline = convergeRuntimeManifest(baselineLoad, upgradePaths, {
			cacheLastGood: false,
			commitAuthority: (convergence, authority) =>
				commitTestRuntimeAuthority(baselineLoad, upgradePaths, convergence, authority),
			egressEngineEnsureOptions: { downloadCommand: baselineCurl.commandPath },
			systemdApply: hooks(() => {}, false),
		});
		expect(baseline.installErrors).toEqual([]);
		expect(baseline.outputs.egressEngine?.status).toBe("ready");
		const sidecarUnit = join(upgradePaths.systemdSystemRoot, "clawdi-runtime-sidecar.service");
		expect(existsSync(sidecarUnit)).toBe(true);
		const previous = capture(managedStatePaths(upgradePaths));

		const upgradeFailure = prepareFailure(upgradePaths, "upgrade");
		const upgradeManifest = egressRuntimeManifest(upgradePaths, {
			generation: 2,
			engine: upgradeFailure.engine,
			profile: "enabled",
		});
		const upgradeLoad = manifestLoad(upgradeManifest, `inline-egress-${failure}-upgrade`);
		let upgradeCommits = 0;
		let rollbackCalls = 0;
		const failedUpgrade = convergeRuntimeManifest(upgradeLoad, upgradePaths, {
			cacheLastGood: false,
			commitAuthority: (convergence, authority) => {
				upgradeCommits += 1;
				commitTestRuntimeAuthority(upgradeLoad, upgradePaths, convergence, authority);
			},
			egressEngineEnsureOptions: { downloadCommand: upgradeFailure.downloadCommand },
			systemdApply: hooks(() => {
				rollbackCalls += 1;
			}, failure === "activation"),
		});
		const upgradeErrors = failedUpgrade.installErrors.join("\n");
		expect(upgradeErrors).toContain(expectedError);
		if (failure !== "activation") {
			expect(upgradeErrors).toStartWith(
				"runtime apply failed: required egress engine is not ready: ",
			);
		}
		expect(upgradeErrors).not.toContain("test-token");
		expect(upgradeCommits).toBe(0);
		expect(rollbackCalls).toBe(1);
		expectSnapshot(previous);
		expect(
			JSON.parse(readFileSync(runtimeRunConfigPath("openclaw", upgradePaths), "utf-8")),
		).toMatchObject({ generation: 1 });
		expect(readRuntimeAppliedState(upgradePaths)?.generation).toBe(1);
		expect(JSON.parse(readFileSync(upgradePaths.manifestLastGood, "utf-8"))).toMatchObject({
			generation: 1,
		});
	});

	test("converges enabled egress when the pinned engine is ready", () => {
		const paths = tempRuntimePaths();
		const artifact = writeTestMitmproxyArchive(paths, "ready-success", "ready");
		const curl = installTestMitmproxyCurl(paths, artifact.path);
		const manifest = egressRuntimeManifest(paths, {
			generation: 1,
			engine: testEgressEnginePin("12.2.3-test-success", artifact.sha256),
			profile: "enabled",
		});
		const load = manifestLoad(manifest, "inline-egress-success");
		let commits = 0;
		const result = convergeRuntimeManifest(load, paths, {
			cacheLastGood: false,
			commitAuthority: (convergence, authority) => {
				commits += 1;
				commitTestRuntimeAuthority(load, paths, convergence, authority);
			},
			egressEngineEnsureOptions: { downloadCommand: curl.commandPath },
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: successfulPrerequisiteActivation,
				rollback: () => {},
			},
		});

		expect(result.installErrors).toEqual([]);
		expect(result.outputs.egressEngine).toEqual(expect.objectContaining({ status: "ready" }));
		expect(commits).toBe(1);
		expect(readRuntimeAppliedState(paths)?.generation).toBe(1);
		expect(existsSync(paths.manifestLastGood)).toBe(true);
		expect(existsSync(join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"))).toBe(true);
	});

	test("activates transparent egress before authenticated managed-model discovery", () => {
		const paths = tempRuntimePaths();
		const commandPath = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const officialUnitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
		mkdirSync(dirname(commandPath), { recursive: true });
		writeFileSync(
			commandPath,
			[
				"#!/usr/bin/env sh",
				'if [ "$1" = "--version" ]; then printf "0.13.26\\n"; exit 0; fi',
				'if [ "$1 $2 $3" = "config patch --stdin" ]; then cat >/dev/null; exit 0; fi',
				'if [ "$1 $2 $3" = "gateway install --force" ]; then',
				`  mkdir -p ${JSON.stringify(dirname(officialUnitPath))}`,
				`  printf '[Unit]\\nDescription=Official gateway\\n\\n[Service]\\nExecStart=openclaw gateway run\\n' > ${JSON.stringify(officialUnitPath)}`,
				"  exit 0",
				"fi",
				"exit 2",
				"",
			].join("\n"),
		);
		chmodSync(commandPath, 0o700);
		const providerSecretRef = "secret://provider.clawdi.apiKey";
		const providers = {
			clawdi: {
				kind: "openai-compatible",
				baseUrl: "https://ai-gateway.clawdi.ai/v1",
				models: [{ id: "gpt-5.5" }],
				apiMode: "openai_responses",
				managed_by: "clawdi",
				runtimeEnvName: "OPENAI_API_KEY",
				apiKeySecretRef: providerSecretRef,
			},
		};
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings(commandPath, ["gateway", "run"]),
					services: {},
					provider_ids: ["clawdi"],
					primary_model: { provider_id: "clawdi", model: "gpt-5.5" },
				},
			},
			{
				openclawGatewayAuth: hostedOpenClawNativeAuth(),
				projection: {
					sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
					system: hostedSystemFixture(),
					providers,
				},
				egressProfiles: hostedManifestEgressProfiles({ providers }),
				egressEngine: installCachedTestEgressEngine(paths, "12.2.3-test-model-probe"),
			},
		);
		const load = manifestLoad(manifest, "managed-model-probe", {
			...TEST_HOSTED_SECRET_VALUES,
			[providerSecretRef]: "test-managed-provider-key",
		});
		const prerequisiteSignals: Array<{ restartEgressSidecar: boolean }> = [];
		const activationSignals: Array<{ restartEgressSidecar: boolean }> = [];
		let probeCalls = 0;
		const converge = () =>
			convergeRuntimeManifest(load, paths, {
				cacheLastGood: false,
				commitAuthority: (convergence, authority) =>
					commitTestRuntimeAuthority(load, paths, convergence, authority),
				managedGatewayModelListFetcher: (input) => {
					probeCalls += 1;
					expect(input.credential).toBe(MANAGED_EGRESS_PLACEHOLDER_VALUE);
					expect(input.egressSystemCaFile).toBe(paths.egressSystemCaFile);
					expect(existsSync(paths.egressSystemCaFile)).toBe(true);
					return {
						status: "ok",
						endpoint: `${input.baseUrl}/models`,
						models: [{ id: "gpt-5.5" }, { id: "gpt-5.6" }],
					};
				},
				systemdApply: {
					activateEgressPrerequisite: (signal) => {
						prerequisiteSignals.push(signal);
						expect(existsSync(paths.egressProfileBundle)).toBe(true);
						expect(existsSync(join(paths.managedSecretRoot, "egress-secrets.json"))).toBe(true);
						expect(
							existsSync(join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service")),
						).toBe(true);
						expect(readFileSync(paths.egressProfileBundle, "utf8")).toContain(
							MANAGED_EGRESS_PLACEHOLDER_VALUE,
						);
						writeFileSync(paths.egressSystemCaFile, "test-ca\n", { mode: 0o644 });
						return successfulPrerequisiteActivation();
					},
					activate: (signal) => {
						activationSignals.push(signal);
						return successfulPrerequisiteActivation();
					},
					rollback: () => {},
				},
			});

		const first = converge();
		expect(first.installErrors).toEqual([]);
		expect(probeCalls).toBe(1);
		expect(prerequisiteSignals).toHaveLength(1);
		expect(prerequisiteSignals[0]?.restartEgressSidecar).toBe(true);
		expect(activationSignals[0]?.restartEgressSidecar).toBe(true);

		const refresh = converge();
		expect(refresh.installErrors).toEqual([]);
		expect(probeCalls).toBe(2);
		expect(prerequisiteSignals).toHaveLength(1);
		expect(activationSignals).toHaveLength(2);
		expect(activationSignals[1]?.restartEgressSidecar).toBe(false);
	});

	test.each([
		"disabled",
		"absent",
	] as const)("does not require the egress engine when profiles are %s", (profile) => {
		const paths = tempRuntimePaths();
		const curl = installTestMitmproxyCurl(paths, null);
		const manifest = egressRuntimeManifest(paths, {
			generation: 1,
			engine: testEgressEnginePin(`12.2.3-test-${profile}`, "a".repeat(64)),
			profile,
		});
		const load = manifestLoad(manifest, `inline-egress-${profile}`);
		let commits = 0;
		const result = convergeRuntimeManifest(load, paths, {
			cacheLastGood: false,
			commitAuthority: (convergence, authority) => {
				commits += 1;
				commitTestRuntimeAuthority(load, paths, convergence, authority);
			},
			egressEngineEnsureOptions: { downloadCommand: curl.commandPath },
		});

		expect(result.installErrors).toEqual([]);
		expect(commits).toBe(1);
		expect(existsSync(curl.markerPath)).toBe(false);
		expect(result.outputs.egressEngine).toBeNull();
		expect(existsSync(paths.egressProfileBundle)).toBe(false);
		expect(existsSync(join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"))).toBe(false);
		expect(readRuntimeAppliedState(paths)?.generation).toBe(1);
	});

	test("restarts only active sidecars for committed egress secret lifecycle changes", () => {
		const paths = tempRuntimePaths();
		const commandPath = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const egressEngine = {
			type: "mitmproxy" as const,
			version: "12.2.3",
			url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
			sha256: "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
		};
		const engineBinary = join(
			paths.egressEngineMaintainedRoot,
			egressEngine.version,
			egressEngine.sha256,
			"mitmdump",
		);
		mkdirSync(dirname(commandPath), { recursive: true });
		writeFileSync(commandPath, "#!/usr/bin/env sh\nexit 0\n");
		chmodSync(commandPath, 0o700);
		mkdirSync(dirname(engineBinary), { recursive: true });
		writeFileSync(engineBinary, "#!/usr/bin/env sh\nexit 0\n");
		chmodSync(engineBinary, 0o700);
		const secretRef = "secret://providers/default/api-key";
		const activeManifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: runSettings(commandPath, ["gateway", "run"]),
					services: {},
				},
			},
			{
				egressEngine,
				egressProfiles: {
					profiles: [
						{
							id: "managed-provider",
							enabled: true,
							kind: "provider",
							match: {
								scheme: "https",
								host: "provider.example.test",
								headers: {},
								query: {},
							},
							rewrite: {
								preservePath: true,
								setHeaders: {
									authorization: {
										type: "secretRef",
										secretRef,
										prefix: "Bearer ",
									},
								},
							},
							logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
							priority: 80,
						},
					],
				},
			},
		);
		const signals: boolean[] = [];
		const converge = (manifest: RuntimeManifest, secret: string | undefined) =>
			convergeRuntimeManifest(
				manifestLoad(
					manifest,
					"inline-egress-secret-lifecycle",
					secret === undefined ? {} : { [secretRef]: secret },
				),
				paths,
				{
					cacheLastGood: false,
					commitAuthority: (_convergence, authority) => {
						writeRuntimeAppliedState(
							{
								schemaVersion: "clawdi.runtimeAppliedState.v2",
								appliedAt: "2026-07-28T00:00:00.000Z",
								instanceId: manifest.instanceId,
								etag: '"egress-lifecycle"',
								sourceRevision: "a".repeat(64),
								generation: manifest.generation,
								contentIdentity: {
									sourcePath: "inline-egress-secret-lifecycle",
									sha256: "b".repeat(64),
								},
								...authority,
								providerIds: [],
								projectedProviderIds: {},
							},
							paths,
						);
					},
					systemdApply: {
						activateEgressPrerequisite: successfulPrerequisiteActivation,
						activate: ({ restartEgressSidecar }) => {
							signals.push(restartEgressSidecar);
							return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
						},
						rollback: () => {},
					},
				},
			);
		const secretFile = join(paths.managedSecretRoot, "egress-secrets.json");
		const sidecarUnit = join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service");

		const initial = converge(activeManifest, "000000");
		expect(initial.installErrors).toEqual([]);
		const renderedGatewayUnit = initial.outputs.systemdUserUnits[0];
		if (!renderedGatewayUnit) throw new Error("active runtime did not render a gateway unit");
		const gatewayUnitName = renderedGatewayUnit.split("/").at(-1);
		if (!gatewayUnitName) throw new Error("rendered gateway unit has no file name");
		const gatewayUnit = join(
			paths.systemdUserRoot,
			`${gatewayUnitName}.d`,
			"10-clawdi-hosted.conf",
		);
		const gatewayEnv = join(paths.systemdEnvRoot, `${gatewayUnitName}.env`);
		expect(signals.at(-1)).toBe(true);
		expect(statSync(secretFile).mode & 0o777).toBe(0o600);
		expect(readFileSync(secretFile, "utf-8")).toContain("000000");
		const activeGatewayUnit = readFileSync(gatewayUnit, "utf-8");
		expect(readFileSync(gatewayEnv, "utf-8")).toContain("NODE_EXTRA_CA_CERTS");

		expect(converge(activeManifest, "000000").installErrors).toEqual([]);
		expect(signals.at(-1)).toBe(false);
		expect(readFileSync(gatewayUnit, "utf-8")).toBe(activeGatewayUnit);

		expect(converge(activeManifest, "000001").installErrors).toEqual([]);
		expect(signals.at(-1)).toBe(true);
		expect(readFileSync(secretFile, "utf-8")).toContain("000001");
		expect(readFileSync(gatewayUnit, "utf-8")).toBe(activeGatewayUnit);

		const changedProfileManifest: RuntimeManifest = {
			...activeManifest,
			egressProfiles: {
				profiles:
					activeManifest.egressProfiles?.profiles.map((profile) => ({
						...profile,
						priority: profile.priority + 1,
					})) ?? [],
			},
		};
		expect(converge(changedProfileManifest, "000001").installErrors).toEqual([]);
		expect(readFileSync(gatewayUnit, "utf-8")).toBe(activeGatewayUnit);

		const noEgressManifest: RuntimeManifest = {
			...activeManifest,
			egressProfiles: { profiles: [] },
		};
		expect(converge(noEgressManifest, undefined).installErrors).toEqual([]);
		expect(readFileSync(gatewayUnit, "utf-8")).not.toBe(activeGatewayUnit);
		expect(readFileSync(gatewayEnv, "utf-8")).not.toContain("NODE_EXTRA_CA_CERTS");

		const noSidecarManifest: RuntimeManifest = {
			...changedProfileManifest,
			runtimes: { openclaw: { ...activeManifest.runtimes.openclaw, enabled: false } },
		};
		expect(converge(noSidecarManifest, "000002").installErrors).toEqual([]);
		expect(signals.at(-1)).toBe(false);
		expect(readFileSync(secretFile, "utf-8")).toContain("000002");
		expect(existsSync(sidecarUnit)).toBe(false);
		expect(readRuntimeAppliedState(paths)?.egressSidecarSecretRevision).toBeUndefined();

		const deletedManifest: RuntimeManifest = {
			...noSidecarManifest,
			egressProfiles: { profiles: [] },
		};
		expect(converge(deletedManifest, undefined).installErrors).toEqual([]);
		expect(signals.at(-1)).toBe(false);
		expect(existsSync(secretFile)).toBe(false);

		expect(converge(deletedManifest, undefined).installErrors).toEqual([]);
		expect(signals.at(-1)).toBe(false);
		expect(signals).toEqual([true, false, true, false, false, false, false, false]);
	});

	test("recovers committed egress secrets before retrying a crash-interrupted sidecar load", () => {
		const paths = tempRuntimePaths();
		const commandPath = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const egressEngine = {
			type: "mitmproxy" as const,
			version: "12.2.3",
			url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
			sha256: "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
		};
		const engineBinary = join(
			paths.egressEngineMaintainedRoot,
			egressEngine.version,
			egressEngine.sha256,
			"mitmdump",
		);
		mkdirSync(dirname(commandPath), { recursive: true });
		writeFileSync(commandPath, "#!/usr/bin/env sh\nexit 0\n");
		chmodSync(commandPath, 0o700);
		mkdirSync(dirname(engineBinary), { recursive: true });
		writeFileSync(engineBinary, "#!/usr/bin/env sh\nexit 0\n");
		chmodSync(engineBinary, 0o700);
		const secretRef = "secret://providers/default/api-key";
		const manifest = manifestSchema.parse(
			baseManifest(
				paths,
				{
					openclaw: {
						enabled: true,
						run: runSettings(commandPath, ["gateway", "run"]),
						services: {},
					},
				},
				{
					egressEngine,
					egressProfiles: {
						profiles: [
							{
								id: "managed-provider",
								enabled: true,
								kind: "provider",
								match: {
									scheme: "https",
									host: "provider.example.test",
									headers: {},
									query: {},
								},
								rewrite: {
									preservePath: true,
									setHeaders: {
										authorization: {
											type: "secretRef",
											secretRef,
											prefix: "Bearer ",
										},
									},
								},
								logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
								priority: 80,
							},
						],
					},
				},
			),
		);
		const secretFile = join(paths.managedSecretRoot, "egress-secrets.json");
		const secrets = (value: string) => ({ [secretRef]: value });
		const load = (value: string) =>
			manifestLoad(manifest, "inline-egress-crash-recovery", secrets(value));
		const writeAuthority = (value: string, egressSidecarSecretRevision?: string) => {
			writeRuntimeAppliedState(
				{
					schemaVersion: "clawdi.runtimeAppliedState.v2",
					appliedAt: "2026-07-28T00:00:00.000Z",
					instanceId: manifest.instanceId,
					etag: `"egress-${value}"`,
					sourceRevision: runtimeContentSha256({ value }),
					generation: manifest.generation,
					contentIdentity: {
						sourcePath: "inline-egress-crash-recovery",
						sha256: runtimeContentSha256({
							manifest,
							secretValues: runtimeRecoverableSecretValues(manifest, secrets(value)),
						}),
					},
					...(egressSidecarSecretRevision ? { egressSidecarSecretRevision } : {}),
					providerIds: [],
					projectedProviderIds: {},
				},
				paths,
			);
		};
		const overwriteLiveSecret = (value: string) => {
			const current = existsSync(secretFile)
				? (JSON.parse(readFileSync(secretFile, "utf-8")) as Record<string, string>)
				: { [secretRef]: value };
			writeFileSync(
				secretFile,
				`${JSON.stringify(
					Object.fromEntries(Object.keys(current).map((ref) => [ref, value])),
					null,
					2,
				)}\n`,
			);
			chmodSync(secretFile, 0o600);
		};
		const commit = (value: string, egressSidecarSecretRevision?: string) => {
			cacheRuntimeLastGoodManifest(manifest, paths, secrets(value));
			writeAuthority(value, egressSidecarSecretRevision);
		};

		let revisionA: string | undefined;
		const baseline = convergeRuntimeManifest(load("000000"), paths, {
			commitAuthority: (_convergence, authority) => {
				revisionA = authority.egressSidecarSecretRevision;
			},
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: () => ({ applied: true, systemUnitsChanged: [], userUnitsChanged: [] }),
				rollback: () => {},
			},
		});
		expect(baseline.installErrors).toEqual([]);
		expect(revisionA).toMatch(/^[a-f0-9]{64}$/);
		commit("000000", revisionA);
		const committedA = readFileSync(paths.appliedState, "utf-8");

		// Simulate SIGKILL after the atomic A -> B file write but before restart.
		overwriteLiveSecret("000001");
		const recoverySignals: boolean[] = [];
		let revisionB: string | undefined;
		const recovered = convergeRuntimeManifest(load("000001"), paths, {
			cacheLastGood: false,
			commitAuthority: (_convergence, authority) => {
				revisionB = authority.egressSidecarSecretRevision;
				commit("000001", revisionB);
			},
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: ({ restartEgressSidecar }) => {
					recoverySignals.push(restartEgressSidecar);
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
				rollback: () => {
					throw new Error("successful recovery must not roll back");
				},
			},
		});
		expect(recovered.installErrors).toEqual([]);
		expect(recoverySignals).toEqual([true]);
		expect(revisionB).toMatch(/^[a-f0-9]{64}$/);
		expect(revisionB).not.toBe(revisionA);
		expect(readFileSync(paths.appliedState, "utf-8")).not.toBe(committedA);
		expect(readRuntimeAppliedState(paths)?.egressSidecarSecretRevision).toBe(revisionB);
		expect(readFileSync(secretFile, "utf-8")).toContain("000001");
		expect(JSON.stringify(recovered)).not.toContain("egressSidecarSecretRevision");
		expect(JSON.stringify(recovered)).not.toContain(revisionB ?? "missing-private-revision");

		// A failed retry restores the verified committed B material before the
		// rollback restart, even though the pre-apply live file already held C.
		overwriteLiveSecret("000002");
		let restartFailureRollbackSecret = "";
		const restartFailed = convergeRuntimeManifest(load("000002"), paths, {
			cacheLastGood: false,
			commitAuthority: () => {
				throw new Error("restart failure must not commit authority");
			},
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: ({ restartEgressSidecar }) => {
					expect(restartEgressSidecar).toBe(true);
					throw new Error("injected sidecar restart failure");
				},
				rollback: ({ restartEgressSidecar }) => {
					expect(restartEgressSidecar).toBe(true);
					restartFailureRollbackSecret = readFileSync(secretFile, "utf-8");
				},
			},
		});
		expect(restartFailed.installErrors.join("\n")).toContain("injected sidecar restart failure");
		expect(restartFailureRollbackSecret).toContain("000001");
		expect(readFileSync(secretFile, "utf-8")).toContain("000001");
		expect(readRuntimeAppliedState(paths)?.egressSidecarSecretRevision).toBe(revisionB);

		// If activation succeeded but the atomic authority commit reports a
		// failure, both authority files and loaded secret material return to B.
		overwriteLiveSecret("000002");
		const committedB = readFileSync(paths.appliedState, "utf-8");
		const committedCacheB = readFileSync(paths.managedSecretCacheFile, "utf-8");
		let commitFailureRollbackSecret = "";
		const commitFailed = convergeRuntimeManifest(load("000002"), paths, {
			cacheLastGood: false,
			commitAuthority: (_convergence, authority) => {
				commit("000002", authority.egressSidecarSecretRevision);
				throw new Error("injected authority commit failure");
			},
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: ({ restartEgressSidecar }) => {
					expect(restartEgressSidecar).toBe(true);
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
				rollback: ({ restartEgressSidecar }) => {
					expect(restartEgressSidecar).toBe(true);
					commitFailureRollbackSecret = readFileSync(secretFile, "utf-8");
				},
			},
		});
		expect(commitFailed.installErrors.join("\n")).toContain("injected authority commit failure");
		expect(commitFailureRollbackSecret).toContain("000001");
		expect(readFileSync(secretFile, "utf-8")).toContain("000001");
		expect(readFileSync(paths.appliedState, "utf-8")).toBe(committedB);
		expect(readFileSync(paths.managedSecretCacheFile, "utf-8")).toBe(committedCacheB);

		// A crash may also advance the live file and cache while applied state
		// remains at B. The desired C restart must run before rollback material
		// is needed, and a successful restart may then commit C.
		overwriteLiveSecret("000002");
		cacheRuntimeLastGoodManifest(manifest, paths, secrets("000002"));
		let mixedSnapshotActivations = 0;
		let revisionC: string | undefined;
		const mixedSnapshot = convergeRuntimeManifest(load("000002"), paths, {
			cacheLastGood: false,
			commitAuthority: (_convergence, authority) => {
				revisionC = authority.egressSidecarSecretRevision;
				commit("000002", revisionC);
			},
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: ({ restartEgressSidecar }) => {
					expect(restartEgressSidecar).toBe(true);
					mixedSnapshotActivations++;
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
				rollback: () => {
					throw new Error("successful mixed-snapshot recovery must not roll back");
				},
			},
		});
		expect(mixedSnapshot.installErrors).toEqual([]);
		expect(mixedSnapshotActivations).toBe(1);
		expect(revisionC).toMatch(/^[a-f0-9]{64}$/);
		expect(revisionC).not.toBe(revisionB);
		expect(readRuntimeAppliedState(paths)?.egressSidecarSecretRevision).toBe(revisionC);

		// If the restart from a mixed D/cache-D/applied-C snapshot fails, only
		// the failure path attempts to recover C. The unverifiable cache then
		// fails closed by removing the sidecar secret while the remaining units
		// still reconcile to the restored filesystem authority.
		overwriteLiveSecret("000003");
		cacheRuntimeLastGoodManifest(manifest, paths, secrets("000003"));
		const committedC = readFileSync(paths.appliedState, "utf-8");
		let mixedFailureCommits = 0;
		let mixedFailureRollbacks = 0;
		let mixedFailureRollbackSignal: {
			restartEgressSidecar: boolean;
			stopEgressSidecar: boolean;
		} | null = null;
		const mixedFailure = convergeRuntimeManifest(load("000003"), paths, {
			cacheLastGood: false,
			commitAuthority: () => {
				mixedFailureCommits++;
			},
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: ({ restartEgressSidecar }) => {
					expect(restartEgressSidecar).toBe(true);
					throw new Error("injected mixed-snapshot restart failure");
				},
				rollback: (signal) => {
					mixedFailureRollbacks++;
					mixedFailureRollbackSignal = signal;
				},
			},
		});
		expect(mixedFailure.installErrors.join("\n")).toContain(
			"injected mixed-snapshot restart failure",
		);
		expect(mixedFailure.installErrors.join("\n")).toContain(
			"runtime egress sidecar stopped because committed secret rollback authority could not be verified",
		);
		expect(mixedFailureCommits).toBe(0);
		expect(mixedFailureRollbacks).toBe(1);
		expect(mixedFailureRollbackSignal).toMatchObject({
			restartEgressSidecar: false,
			stopEgressSidecar: true,
		});
		expect(readFileSync(paths.appliedState, "utf-8")).toBe(committedC);
		expect(readRuntimeAppliedState(paths)?.egressSidecarSecretRevision).toBe(revisionC);
		expect(existsSync(secretFile)).toBe(false);

		// Legacy applied state can recover A from an exact content-identity
		// match even when an interrupted write left unrelated live B bytes. A
		// failed desired-C restart must load only the verified A material.
		const legacyCommitted = "legacy-committed-a";
		const legacyInterrupted = "legacy-live-b";
		const legacyDesired = "legacy-desired-c";
		cacheRuntimeLastGoodManifest(manifest, paths, secrets(legacyCommitted));
		writeAuthority(legacyCommitted);
		overwriteLiveSecret(legacyInterrupted);
		const legacyAppliedA = readFileSync(paths.appliedState, "utf-8");
		let legacyFailureCommits = 0;
		const legacyRollbackSecrets: string[] = [];
		const legacyRestartFailure = convergeRuntimeManifest(load(legacyDesired), paths, {
			cacheLastGood: false,
			commitAuthority: () => {
				legacyFailureCommits++;
			},
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: ({ restartEgressSidecar }) => {
					expect(restartEgressSidecar).toBe(true);
					expect(readFileSync(secretFile, "utf-8")).toContain(legacyDesired);
					throw new Error("injected legacy desired restart failure");
				},
				rollback: ({ restartEgressSidecar }) => {
					expect(restartEgressSidecar).toBe(true);
					legacyRollbackSecrets.push(readFileSync(secretFile, "utf-8"));
				},
			},
		});
		expect(legacyRestartFailure.installErrors.join("\n")).toContain(
			"injected legacy desired restart failure",
		);
		expect(legacyFailureCommits).toBe(0);
		expect(legacyRollbackSecrets).toHaveLength(1);
		expect(legacyRollbackSecrets[0]).toContain(legacyCommitted);
		expect(legacyRollbackSecrets[0]).not.toContain(legacyInterrupted);
		expect(readFileSync(secretFile, "utf-8")).toContain(legacyCommitted);
		expect(readFileSync(paths.appliedState, "utf-8")).toBe(legacyAppliedA);
		expect(readRuntimeAppliedState(paths)?.egressSidecarSecretRevision).toBeUndefined();
		expect(JSON.stringify(legacyRestartFailure)).not.toContain("egressSidecarSecretRevision");

		// A legacy cache without its active egress secret cannot prove A. The
		// desired restart still runs, but its failure must remove the unverified
		// snapshot B, stop the sidecar, and reconcile every independent unit.
		cacheRuntimeLastGoodManifest(manifest, paths, secrets(legacyCommitted));
		rmSync(paths.managedSecretCacheFile);
		writeAuthority(legacyCommitted);
		overwriteLiveSecret(legacyInterrupted);
		const legacyMissingCacheApplied = readFileSync(paths.appliedState, "utf-8");
		let legacyMissingCacheRestartCommits = 0;
		let legacyMissingCacheRestartRollbacks = 0;
		let legacyMissingCacheRestartSignal: {
			restartEgressSidecar: boolean;
			stopEgressSidecar: boolean;
		} | null = null;
		const legacyMissingCacheRestartFailure = convergeRuntimeManifest(load(legacyDesired), paths, {
			cacheLastGood: false,
			commitAuthority: () => {
				legacyMissingCacheRestartCommits++;
			},
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: ({ restartEgressSidecar }) => {
					expect(restartEgressSidecar).toBe(true);
					expect(readFileSync(secretFile, "utf-8")).toContain(legacyDesired);
					throw new Error("injected legacy missing-cache restart failure");
				},
				rollback: (signal) => {
					legacyMissingCacheRestartRollbacks++;
					legacyMissingCacheRestartSignal = signal;
				},
			},
		});
		expect(legacyMissingCacheRestartFailure.installErrors[0]).toBe(
			"runtime apply failed: injected legacy missing-cache restart failure",
		);
		expect(legacyMissingCacheRestartFailure.installErrors.join("\n")).toContain(
			"injected legacy missing-cache restart failure",
		);
		expect(legacyMissingCacheRestartFailure.installErrors.join("\n")).toContain(
			"runtime egress sidecar stopped because committed secret rollback authority could not be verified",
		);
		expect(legacyMissingCacheRestartCommits).toBe(0);
		expect(legacyMissingCacheRestartRollbacks).toBe(1);
		expect(legacyMissingCacheRestartSignal).toMatchObject({
			restartEgressSidecar: false,
			stopEgressSidecar: true,
		});
		expect(readFileSync(paths.appliedState, "utf-8")).toBe(legacyMissingCacheApplied);
		expect(existsSync(paths.managedSecretCacheFile)).toBe(false);
		expect(existsSync(secretFile)).toBe(false);

		// The same unverified legacy state also fails the sidecar closed if
		// desired activation succeeds but the following authority commit fails.
		let legacyMissingCacheCommits = 0;
		let legacyMissingCacheRollbacks = 0;
		let legacyMissingCacheSignal: {
			restartEgressSidecar: boolean;
			stopEgressSidecar: boolean;
		} | null = null;
		const legacyMissingCacheActivationSecrets: string[] = [];
		const legacyMissingCacheFailure = convergeRuntimeManifest(load(legacyDesired), paths, {
			cacheLastGood: false,
			commitAuthority: (_convergence, authority) => {
				legacyMissingCacheCommits++;
				commit(legacyDesired, authority.egressSidecarSecretRevision);
				throw new Error("injected legacy authority commit failure");
			},
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: ({ restartEgressSidecar }) => {
					expect(restartEgressSidecar).toBe(true);
					legacyMissingCacheActivationSecrets.push(readFileSync(secretFile, "utf-8"));
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
				rollback: (signal) => {
					legacyMissingCacheRollbacks++;
					legacyMissingCacheSignal = signal;
				},
			},
		});
		expect(legacyMissingCacheFailure.installErrors[0]).toBe(
			"runtime apply failed: injected legacy authority commit failure",
		);
		expect(legacyMissingCacheFailure.installErrors.join("\n")).toContain(
			"injected legacy authority commit failure",
		);
		expect(legacyMissingCacheFailure.installErrors.join("\n")).toContain(
			"runtime egress sidecar stopped because committed secret rollback authority could not be verified",
		);
		expect(legacyMissingCacheCommits).toBe(1);
		expect(legacyMissingCacheRollbacks).toBe(1);
		expect(legacyMissingCacheSignal).toMatchObject({
			restartEgressSidecar: false,
			stopEgressSidecar: true,
		});
		expect(legacyMissingCacheActivationSecrets).toHaveLength(1);
		expect(legacyMissingCacheActivationSecrets[0]).toContain(legacyDesired);
		expect(readFileSync(paths.appliedState, "utf-8")).toBe(legacyMissingCacheApplied);
		expect(readRuntimeAppliedState(paths)?.egressSidecarSecretRevision).toBeUndefined();
		expect(existsSync(paths.managedSecretCacheFile)).toBe(false);
		expect(existsSync(secretFile)).toBe(false);
		expect(JSON.stringify(legacyMissingCacheFailure)).not.toContain("egressSidecarSecretRevision");

		// Legacy v2 authority has no private revision. An active sidecar restarts
		// once, commits it, and then an identical apply no longer forces restart.
		cacheRuntimeLastGoodManifest(manifest, paths, secrets("000001"));
		overwriteLiveSecret("000001");
		writeAuthority("000001");
		const legacySignals: boolean[] = [];
		const convergeLegacy = () =>
			convergeRuntimeManifest(load("000001"), paths, {
				cacheLastGood: false,
				commitAuthority: (_convergence, authority) =>
					writeAuthority("000001", authority.egressSidecarSecretRevision),
				systemdApply: {
					activateEgressPrerequisite: successfulPrerequisiteActivation,
					activate: ({ restartEgressSidecar }) => {
						legacySignals.push(restartEgressSidecar);
						return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
					},
					rollback: () => {},
				},
			});
		expect(convergeLegacy().installErrors).toEqual([]);
		expect(readRuntimeAppliedState(paths)?.egressSidecarSecretRevision).toBe(revisionB);
		expect(convergeLegacy().installErrors).toEqual([]);
		expect(legacySignals).toEqual([true, false]);
	});

	test("replaces an unverifiable legacy secret cache after a successful online upgrade", () => {
		const paths = tempRuntimePaths();
		const engine = installCachedTestEgressEngine(paths, "12.2.3");
		const canonicalSecretRef = "secret://tool.codex.apiKey";
		const base = egressRuntimeManifest(paths, {
			generation: 19,
			engine,
			profile: "enabled",
		});
		const profile = base.egressProfiles?.profiles[0];
		if (!profile) throw new Error("expected enabled egress profile fixture");
		const currentManifest = manifestSchema.parse({
			...base,
			issuedAt: "2026-07-01T00:19:00.000Z",
			egressProfiles: {
				profiles: [
					{
						...profile,
						rewrite: {
							...profile.rewrite,
							setHeaders: {
								authorization: {
									type: "secretRef",
									secretRef: canonicalSecretRef,
									prefix: "Bearer ",
								},
							},
						},
					},
				],
			},
		});
		const retainedManifest = {
			...currentManifest,
			generation: 15,
			issuedAt: "2026-07-01T00:15:00.000Z",
			egressProfiles: {
				profiles: [
					profile,
					{
						...profile,
						id: "legacy-env-ref",
						rewrite: {
							...profile.rewrite,
							setHeaders: {
								authorization: {
									type: "secretRef",
									secretRef: "env://REDACTED_LEGACY_NAME",
									prefix: "Bearer ",
								},
							},
						},
					},
				],
			},
		};
		const retainedSecretValues = {
			...TEST_HOSTED_SECRET_VALUES,
			"clawdi/auth-token": TEST_HOSTED_SECRET_VALUES["secret://clawdi/auth-token"],
			"runtime/openclaw/gateway-token":
				TEST_HOSTED_SECRET_VALUES["secret://runtime/openclaw/gateway-token"],
			"tool.codex.apiKey": TEST_HOSTED_SECRET_VALUES[canonicalSecretRef],
		};
		const currentSecretValues = {
			"secret://clawdi/auth-token": "generation-19-auth-token",
			"secret://runtime/openclaw/gateway-token": "canonical-generation-19-gateway",
			[canonicalSecretRef]: "generation-19-egress-token",
		};
		const currentLoad = manifestLoad(
			currentManifest,
			"inline-generation-19-online-upgrade",
			currentSecretValues,
		);
		if (!currentLoad.applyContext) throw new Error("expected apply context fixture");

		mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
		writeFileSync(paths.manifestLastGood, `${JSON.stringify(retainedManifest, null, 2)}\n`);
		writeFileSync(
			paths.managedSecretCacheFile,
			`${JSON.stringify(retainedSecretValues, null, 2)}\n`,
		);
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-01T00:15:00.000Z",
				instanceId: currentManifest.instanceId,
				etag: '"generation-15"',
				sourceRevision: runtimeContentSha256({ generation: 15 }),
				generation: 15,
				contentIdentity: {
					sourcePath: "retained-generation-15",
					sha256: runtimeContentSha256({
						manifest: retainedManifest,
						secretValues: retainedSecretValues,
					}),
				},
				providerIds: [],
				projectedProviderIds: {},
			},
			paths,
		);
		expect(loadCommittedRuntimeManifest(paths, currentLoad.applyContext)).toHaveProperty("errors");

		let activations = 0;
		let rollbacks = 0;
		const convergence = convergeRuntimeManifest(currentLoad, paths, {
			cacheLastGood: false,
			commitAuthority: (committedConvergence, authority) =>
				commitTestRuntimeAuthority(currentLoad, paths, committedConvergence, authority),
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: ({ restartEgressSidecar }) => {
					expect(restartEgressSidecar).toBe(true);
					expect(
						readFileSync(join(paths.managedSecretRoot, "egress-secrets.json"), "utf-8"),
					).toContain("generation-19-egress-token");
					activations++;
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
				rollback: () => {
					rollbacks++;
				},
			},
		});

		expect(convergence.installErrors).toEqual([]);
		expect(activations).toBe(1);
		expect(rollbacks).toBe(0);
		expect(JSON.parse(readFileSync(paths.manifestLastGood, "utf-8"))).toEqual(currentManifest);
		expect(JSON.parse(readFileSync(paths.managedSecretCacheFile, "utf-8"))).toEqual({
			"secret://runtime/openclaw/gateway-token": "canonical-generation-19-gateway",
			[canonicalSecretRef]: "generation-19-egress-token",
		});
		expect(readRuntimeAppliedState(paths)).toMatchObject({
			generation: 19,
			egressSidecarSecretRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		const committedSecretCache = readFileSync(paths.managedSecretCacheFile, "utf-8");
		const committedCache = [
			readFileSync(paths.manifestLastGood, "utf-8"),
			committedSecretCache,
		].join("\n");
		expect(committedCache).not.toContain("env://");
		expect(committedCache).not.toContain("legacy-env-ref");
		expect(committedSecretCache).not.toContain(': "test-auth-token"');
		expect(committedSecretCache).not.toContain(': "gateway-token"');
		expect(committedSecretCache).not.toContain(': "test-codex-provider-key"');
	});

	test("advances last-good manifest only after a clean converge", () => {
		const paths = tempRuntimePaths();
		const openclawCommand = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
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
			{
				commitAuthority: () => authorityCommits++,
				executeOfficialServiceInstallers: true,
			},
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
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
		mkdirSync(dirname(paths.appliedState), { recursive: true });
		writeFileSync(soulPath, "<!-- >>> clawdi managed locale >>>\nmalformed\n");
		writeFileSync(paths.managedConfig, '{"generation":1}\n');
		writeFileSync(staleRunConfig, '{"generation":1}\n');
		writeFileSync(systemdUnit, "old unit\n");
		writeFileSync(paths.manifestLastGood, '{"generation":1}\n');
		writeFileSync(paths.appliedState, '{"generation":1}\n');
		const preservedPaths = [
			soulPath,
			paths.managedConfig,
			staleRunConfig,
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

	test("keeps the hosted skill ledger root owned while mutating the runtime-user skill tree", () => {
		if (process.geteuid?.() !== 0) return;
		const paths = tempRuntimePaths();
		const fixtureRoot = dirname(paths.serviceStateRoot);
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		const skillDir = join(paths.userHome, ".hermes", "skills", "clawdi");
		const ledger = join(paths.projectionRoot, "managed-skills.json");
		const cliRoot = resolve(import.meta.dir, "../..");
		const skillSource = join(cliRoot, "skills", "hosted-versions", "1", "clawdi");
		const protectedSourceAncestors = [
			skillSource,
			dirname(skillSource),
			dirname(dirname(skillSource)),
			dirname(dirname(dirname(skillSource))),
			cliRoot,
		];
		const originalSourceModes = new Map(
			protectedSourceAncestors.map((path) => [path, statSync(path).mode & 0o777]),
		);
		const runtimeUid = Number.parseInt(
			execFileSync("id", ["-u", "nobody"], { encoding: "utf8" }).trim(),
			10,
		);
		const runtimeGid = Number.parseInt(
			execFileSync("id", ["-g", "nobody"], { encoding: "utf8" }).trim(),
			10,
		);
		process.env.CLAWDI_RUNTIME_USER = "nobody";
		process.env.CLAWDI_RUNTIME_MODE = "hosted";

		chmodSync(fixtureRoot, 0o755);
		mkdirSync(paths.projectionRoot, { recursive: true });
		chmodSync(paths.projectionRoot, 0o755);
		mkdirSync(paths.clawdiHome, { recursive: true });
		chownSync(paths.clawdiHome, runtimeUid, runtimeGid);
		mkdirSync(dirname(hermesCommand), { recursive: true });
		writeFileSync(hermesCommand, "#!/bin/sh\nexit 0\n");
		chmodSync(hermesCommand, 0o755);

		const manifest = baseManifest(
			paths,
			{
				hermes: {
					enabled: true,
					run: runSettings(hermesCommand, ["gateway"]),
					services: {},
				},
			},
			{ projection: { skills: { entries: { clawdi: { enabled: true, version: 1 } } } } },
		);
		const driftedSource = join(fixtureRoot, "drifted-skill-source");
		cpSync(skillSource, driftedSource, { recursive: true });
		writeFileSync(join(driftedSource, "SKILL.md"), "catalog drift\n");
		expect(() => loadHostedBundledSkill("clawdi", 1, driftedSource)).toThrow(
			"catalog digest mismatch",
		);

		for (const path of protectedSourceAncestors) chmodSync(path, 0o700);
		try {
			for (const path of protectedSourceAncestors) {
				expect(() => execFileSync("runuser", ["-u", "nobody", "--", "test", "-x", path])).toThrow();
			}
			expect(() =>
				execFileSync("runuser", [
					"-u",
					"nobody",
					"--",
					"test",
					"-r",
					join(skillSource, "SKILL.md"),
				]),
			).toThrow();
			const result = convergeRuntimeManifest(manifestLoad(manifest, "inline-hermes-skill"), paths);
			expect(result.installErrors).toEqual([]);
			expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("# Clawdi");
			expect(statSync(skillDir).uid).toBe(runtimeUid);
			expect(statSync(join(skillDir, "SKILL.md")).uid).toBe(runtimeUid);
			expect(statSync(paths.projectionRoot).uid).toBe(0);
			expect(statSync(paths.projectionRoot).mode & 0o777).toBe(0o755);
			expect(statSync(ledger).uid).toBe(0);
			expect(statSync(ledger).mode & 0o022).toBe(0);
			for (const path of protectedSourceAncestors) {
				expect(statSync(path).mode & 0o777).toBe(0o700);
			}

			expect(() =>
				execFileSync("runuser", ["-u", "nobody", "--", "test", "-w", paths.projectionRoot]),
			).toThrow();

			const removal = convergeRuntimeManifest(
				manifestLoad(
					{ ...manifest, projection: { skills: { entries: {} } } },
					"inline-hermes-skill-removal",
				),
				paths,
			);

			expect(removal.installErrors).toEqual([]);
			expect(existsSync(skillDir)).toBe(false);
			expect(readFileSync(ledger, "utf8")).not.toContain(skillDir);
			expect(statSync(ledger).uid).toBe(0);
			expect(statSync(ledger).mode & 0o022).toBe(0);
			for (const path of protectedSourceAncestors) {
				expect(statSync(path).mode & 0o777).toBe(0o700);
			}
		} finally {
			for (const [path, mode] of [...originalSourceModes].reverse()) chmodSync(path, mode);
		}
	});

	test("restores exact root and runtime-user targets before systemd rollback reconciliation", () => {
		const paths = tempRuntimePaths();
		const workspaceRoot = join(paths.userHome, "clawdi");
		const commandPath = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const targetConfig = join(paths.userHome, ".openclaw", "openclaw.json");
		const dropInRoot = join(paths.systemdUserRoot, "clawdi-stale.service.d");
		const managedUserDropIn = join(dropInRoot, "10-clawdi-hosted.conf");
		const siblingUserDropIn = join(dropInRoot, "50-user.conf");
		const unmanagedState = join(paths.serviceStateRoot, "unmanaged.txt");
		const unmanagedRun = join(paths.runRoot, "unmanaged.txt");
		const unmanagedOpenClaw = join(paths.userHome, ".openclaw", "user-data.txt");
		const unmanagedHermes = join(paths.userHome, ".hermes", "user-data.txt");
		const unmanagedFifo = join(paths.runRoot, "unmanaged.fifo");
		mkdirSync(dirname(commandPath), { recursive: true });
		mkdirSync(workspaceRoot, { recursive: true });
		mkdirSync(dirname(paths.managedConfig), { recursive: true });
		mkdirSync(paths.runConfigRoot, { recursive: true });
		mkdirSync(paths.systemdEnvRoot, { recursive: true });
		mkdirSync(paths.managedSecretRoot, { recursive: true });
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		chmodSync(paths.runConfigRoot, 0o755);
		chmodSync(paths.systemdEnvRoot, 0o755);
		chmodSync(paths.managedSecretRoot, 0o711);
		writeFileSync(
			commandPath,
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				"cat >/dev/null || true",
				`printf '%s\\n' '{"forward-converged":true}' > '${targetConfig}'`,
				"",
			].join("\n"),
		);
		chmodSync(commandPath, 0o700);
		mkdirSync(dropInRoot, { recursive: true });
		writeFileSync(
			managedUserDropIn,
			`${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\nstale managed drop-in\n`,
		);
		writeFileSync(siblingUserDropIn, "user-owned\n");
		const previousManagedUserDropIn = readFileSync(managedUserDropIn);
		const previousSiblingUserDropIn = readFileSync(siblingUserDropIn);
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
		const rootManagedPaths = [paths.managedConfig];
		const forwardRunConfig = join(paths.runConfigRoot, "openclaw.json");
		const staleUserUnit = join(paths.systemdUserRoot, "clawdi-old.service");
		const userEnvironment = join(paths.systemdEnvRoot, "openclaw-gateway.service.env");
		const systemEnvironment = join(paths.systemdEnvRoot, "clawdi-daemon.service.env");
		for (const [index, path] of [
			...rootManagedPaths,
			forwardRunConfig,
			staleUserUnit,
			targetConfig,
			userEnvironment,
			systemEnvironment,
		].entries()) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, path === targetConfig ? '{"mcp":{"servers":{}}}\n' : `old-${index}\n`);
		}
		chmodSync(paths.managedConfig, 0o640);
		const previousManagedStat = statSync(paths.managedConfig);
		const previous = new Map(rootManagedPaths.map((path) => [path, readFileSync(path)]));
		const previousSystemEnvironment = readFileSync(systemEnvironment);
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
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: () => {
					activateCalls += 1;
					throw new Error("injected systemd activation failure");
				},
				rollback: () => {
					rollbackCalls += 1;
				},
			},
		});
		expect(result.installErrors.join("\n")).toContain("injected systemd activation failure");
		for (const path of rootManagedPaths) {
			const expected = previous.get(path);
			if (!expected) throw new Error(`missing preserved fixture for ${path}`);
			expect(readFileSync(path)).toEqual(expected);
		}
		expect(readFileSync(forwardRunConfig, "utf-8")).toContain("old-");
		expect(readFileSync(targetConfig, "utf-8")).toBe('{"mcp":{"servers":{}}}\n');
		expect(readFileSync(userEnvironment, "utf-8")).toContain("old-");
		expect(readFileSync(systemEnvironment)).toEqual(previousSystemEnvironment);
		expect(readFileSync(staleUserUnit, "utf-8")).toContain("old-");
		expect(readFileSync(managedUserDropIn)).toEqual(previousManagedUserDropIn);
		expect(readFileSync(siblingUserDropIn)).toEqual(previousSiblingUserDropIn);
		const restoredManagedStat = statSync(paths.managedConfig);
		expect(restoredManagedStat.mode & 0o777).toBe(previousManagedStat.mode & 0o777);
		expect(restoredManagedStat.uid).toBe(previousManagedStat.uid);
		expect(restoredManagedStat.gid).toBe(previousManagedStat.gid);
		for (const [path, expected] of unmanagedContents) {
			expect(readFileSync(path)).toEqual(expected);
		}
		expect(statSync(unmanagedFifo).isFIFO()).toBe(true);
		expect(activateCalls).toBe(1);
		expect(rollbackCalls).toBe(1);
	});

	test("keeps stale systemd files through authority commit and removes them afterward", () => {
		const paths = tempRuntimePaths();
		const staleSystemUnit = join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service");
		const staleUserUnit = join(paths.systemdUserRoot, "clawdi-old.service");
		const staleDropIn = join(
			paths.systemdUserRoot,
			"openclaw-gateway.service.d",
			"10-clawdi-hosted.conf",
		);
		const staleUserWant = join(paths.systemdUserRoot, "default.target.wants", "clawdi-old.service");
		const staleDropInWant = join(
			paths.systemdUserRoot,
			"default.target.wants",
			"openclaw-gateway.service",
		);
		const staleUserEnvironment = join(paths.systemdEnvRoot, "clawdi-old.service.env");
		const staleDropInEnvironment = join(paths.systemdEnvRoot, "openclaw-gateway.service.env");
		const staleFiles = [
			staleSystemUnit,
			staleUserUnit,
			staleDropIn,
			staleUserWant,
			staleDropInWant,
			staleUserEnvironment,
			staleDropInEnvironment,
		];
		for (const path of staleFiles) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\nstale\n`);
		}
		for (const path of [
			paths.systemdSystemRoot,
			paths.systemdUserRoot,
			paths.systemdEnvRoot,
			dirname(staleDropIn),
			dirname(staleUserWant),
		]) {
			chmodSync(path, 0o755);
		}
		const systemctl = join(dirname(paths.serviceStateRoot), "systemctl-success.sh");
		writeFileSync(systemctl, "#!/bin/sh\nexit 0\n");
		chmodSync(systemctl, 0o755);
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const manifest = baseManifest(paths, {});
		let activated = false;
		let committed = false;

		const result = convergeRuntimeManifest(
			manifestLoad(manifest, "systemd-post-commit-gc"),
			paths,
			{
				cacheLastGood: false,
				commitAuthority: () => {
					expect(activated).toBe(true);
					for (const path of staleFiles) expect(existsSync(path)).toBe(true);
					committed = true;
				},
				systemdApply: {
					activateEgressPrerequisite: successfulPrerequisiteActivation,
					activate: (signal) => {
						expect(signal.staleSystemUnits).toEqual(["clawdi-runtime-sidecar.service"]);
						expect(signal.staleUserUnits).toEqual([
							"clawdi-old.service",
							"openclaw-gateway.service",
						]);
						for (const path of staleFiles) expect(existsSync(path)).toBe(true);
						activated = true;
						return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
					},
					rollback: () => {
						throw new Error("rollback must not run after a successful authority commit");
					},
				},
			},
		);

		expect(result.installErrors).toEqual([]);
		expect(committed).toBe(true);
		for (const path of staleFiles) expect(existsSync(path)).toBe(false);
	});

	test("uses an explicit managed snapshot allowlist without broad runtime roots", () => {
		const paths = tempRuntimePaths();
		const workspaceRoot = join(paths.userHome, "clawdi");
		const manifest = baseManifest(paths, {
			openclaw: { enabled: true, run: runSettings("openclaw", []), services: {} },
			hermes: { enabled: true, run: runSettings("hermes", []), services: {} },
		});
		const existingSystemUnit = join(paths.systemdSystemRoot, "clawdi-existing.service");
		const existingSystemDropIn = join(
			paths.systemdSystemRoot,
			"vendor.service.d",
			"10-clawdi-hosted.conf",
		);
		mkdirSync(dirname(existingSystemDropIn), { recursive: true });
		writeFileSync(existingSystemUnit, "existing managed unit\n");
		writeFileSync(
			existingSystemDropIn,
			`${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\nexisting managed drop-in\n`,
		);
		const snapshotPaths = runtimeRootLiveMutationTargets(manifest, paths);
		const openClawDatabase = join(
			paths.userHome,
			".openclaw",
			"agents",
			"main",
			"agent",
			"openclaw-agent.sqlite",
		);

		expect(snapshotPaths).toEqual(
			[
				paths.managedConfig,
				paths.syncState,
				paths.providerHealthStatus,
				paths.egressEngineStatus,
				paths.manifestLastGood,
				paths.managedSecretCacheFile,
				paths.appliedState,
				paths.oauthCredentialRoot,
				join(paths.serviceStateRoot, "status", "runtime-install-receipts.json"),
				paths.runConfigRoot,
				paths.egressProfileRoot,
				paths.installInventory,
				paths.projectionRoot,
				join(paths.instanceRoot, manifest.instanceId),
				paths.daemonAuthToken,
				join(paths.managedSecretRoot, "egress-secrets.json"),
				join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env"),
				join(paths.systemdEnvRoot, "clawdi-daemon.service.env"),
				join(paths.systemdEnvRoot, "clawdi-runtime-sidecar.service.env"),
				paths.instanceData,
				paths.sensitiveInstanceData,
				paths.egressAddon,
				paths.egressTransparentEnv,
				paths.egressSystemCaFile,
				join(paths.serviceStateRoot, "config", "runtime-live-sync-agents.json"),
				join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
				join(paths.systemdSystemRoot, "clawdi-daemon.service"),
				join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"),
				existingSystemUnit,
				existingSystemDropIn,
			].sort(),
		);
		expect(runtimeUserMutationTargets(manifest, paths, workspaceRoot, new Map())).toEqual(
			expect.arrayContaining([
				join(paths.userHome, ".hermes", "auth.json"),
				join(paths.userHome, ".hermes", "auth.lock"),
				openClawDatabase,
				`${openClawDatabase}-wal`,
				`${openClawDatabase}-shm`,
			]),
		);
		for (const userWritablePath of [
			paths.serviceStateRoot,
			paths.runRoot,
			paths.userHome,
			workspaceRoot,
			join(workspaceRoot, "SOUL.md"),
			join(paths.userHome, ".openclaw", "openclaw.json"),
			join(paths.userHome, ".hermes", "config.yaml"),
			join(paths.userHome, ".hermes", "SOUL.md"),
			join(paths.userHome, ".hermes", "plugins", "model-providers", "clawdi"),
			join(paths.userHome, ".codex", "config.toml"),
			join(paths.userHome, ".openclaw", "agents", "main", "skills", "clawdi"),
			join(paths.userHome, ".hermes", "skills", "clawdi"),
			join(paths.localEnvironments, "openclaw.json"),
			join(paths.systemdUserRoot, "clawdi-openclaw.service"),
			join(paths.systemdUserRoot, "openclaw-gateway.service.d", "10-clawdi-hosted.conf"),
			join(paths.systemdUserRoot, "default.target.wants", "clawdi-openclaw.service"),
			join(paths.userHome, ".openclaw", "credentials", "whatsapp", "account"),
			paths.egressRoot,
			paths.egressScratchRoot,
			paths.egressCaDir,
			paths.systemdEnvRoot,
		]) {
			expect(snapshotPaths).not.toContain(userWritablePath);
		}
		for (const [index, path] of snapshotPaths.entries()) {
			for (const other of snapshotPaths.slice(index + 1)) {
				expect(other.startsWith(`${path}/`) || path.startsWith(`${other}/`)).toBe(false);
			}
		}

		mkdirSync(paths.projectionRoot, { recursive: true });
		chmodSync(paths.projectionRoot, 0o777);
		expect(() =>
			convergeRuntimeManifest(manifestLoad(baseManifest(paths, {}), "inline-writable-root"), paths),
		).toThrow(`runtime managed directory is group/world writable: ${paths.projectionRoot}`);

		for (const key of ["runConfigRoot", "systemdEnvRoot"] as const) {
			const unsafePaths = tempRuntimePaths();
			mkdirSync(unsafePaths[key], { recursive: true });
			chmodSync(unsafePaths[key], 0o777);
			expect(() =>
				convergeRuntimeManifest(
					manifestLoad(baseManifest(unsafePaths, {}), `inline-writable-${key}`),
					unsafePaths,
				),
			).toThrow(`runtime managed directory is group/world writable: ${unsafePaths[key]}`);
		}

		const symlinkPaths = tempRuntimePaths();
		const redirectedRoot = join(dirname(symlinkPaths.serviceStateRoot), "redirected-run-config");
		mkdirSync(redirectedRoot, { recursive: true });
		mkdirSync(dirname(symlinkPaths.runConfigRoot), { recursive: true });
		symlinkSync(redirectedRoot, symlinkPaths.runConfigRoot);
		expect(() =>
			convergeRuntimeManifest(
				manifestLoad(baseManifest(symlinkPaths, {}), "inline-symlink-run-config"),
				symlinkPaths,
			),
		).toThrow(`runtime managed directory is not a real directory: ${symlinkPaths.runConfigRoot}`);
	});

	test("snapshots exact installer targets only when the planned executable is missing", () => {
		const paths = tempRuntimePaths();
		const home = paths.userHome;
		const install = (runtime: "openclaw" | "hermes") => ({
			authority: "official" as const,
			method: "official-installer" as const,
			url: OFFICIAL_INSTALL_URLS[runtime],
			home,
			args: OFFICIAL_INSTALL_ARGS[runtime] ?? [],
		});
		const manifest = baseManifest(
			paths,
			{
				openclaw: { enabled: true, install: install("openclaw"), services: {} },
				hermes: { enabled: true, install: install("hermes"), services: {} },
			},
			{ projection: { channels: { discord: {} } } },
		);
		const expectedHermesTargets = [
			join(home, ".hermes", "hermes-agent"),
			join(home, ".hermes", "bin"),
			join(home, ".hermes", "node"),
			join(home, ".hermes", "uv"),
			join(home, ".hermes", ".env"),
			join(home, ".hermes", ".no-bundled-skills"),
			join(home, ".local", "bin", "hermes"),
			join(home, ".local", "bin", "hermes-acp"),
			join(home, ".local", "bin", "node"),
			join(home, ".local", "bin", "npm"),
			join(home, ".local", "bin", "npx"),
		].sort();
		const missingTargets = runtimeInstallerMutationTargets(
			manifest,
			home,
			new Map([
				["openclaw", { status: "present" as const }],
				["hermes", { status: "configured" as const }],
			]),
		).sort();
		expect(missingTargets).toEqual(expectedHermesTargets);
		const missingSnapshot = captureRuntimeLiveSnapshot({
			rootTargets: [],
			trustedRootDirectories: [],
			runtimeUserTargets: missingTargets,
			runtimeUserTrustedRoots: [home],
			runtimeUserSymlinkTargets: [],
			metadataTargets: [],
		});
		for (const target of expectedHermesTargets) {
			expect(missingSnapshot.entries.has(target)).toBe(true);
		}

		const largeInstalledTree = join(home, ".hermes", "hermes-agent");
		mkdirSync(largeInstalledTree, { recursive: true });
		writeFileSync(join(largeInstalledTree, "large-artifact.bin"), Buffer.alloc(4 * 1024 * 1024));
		const installedTargets = runtimeInstallerMutationTargets(
			manifest,
			home,
			new Map([
				["openclaw", { status: "present" as const }],
				["hermes", { status: "present" as const }],
			]),
		);
		expect(installedTargets).toEqual([]);
		const installedUserTargets = runtimeUserMutationTargets(
			manifest,
			paths,
			join(home, "clawdi"),
			new Map([
				["openclaw", { status: "present" as const }],
				["hermes", { status: "present" as const }],
			]),
		);
		expect(installedUserTargets).toContain(join(home, ".openclaw", "extensions", "discord"));
		expect(installedUserTargets).not.toContain(largeInstalledTree);
		manifest.runtimes.hermes.services.dashboard = runSettings("hermes", ["dashboard"]);
		const dashboardTargets = runtimeUserMutationTargets(
			manifest,
			paths,
			join(home, "clawdi"),
			new Map([
				["openclaw", { status: "present" as const }],
				["hermes", { status: "present" as const }],
			]),
		);
		expect(dashboardTargets).toContain(join(largeInstalledTree, "hermes_cli", "web_dist"));
		expect(dashboardTargets).not.toContain(largeInstalledTree);
		expect(
			captureRuntimeLiveSnapshot({
				rootTargets: [],
				trustedRootDirectories: [],
				runtimeUserTargets: installedTargets,
				runtimeUserTrustedRoots: [home],
				runtimeUserSymlinkTargets: [],
				metadataTargets: [],
			}).entries.size,
		).toBe(0);

		manifest.runtimes.openclaw.provider_ids = ["openai-codex"];
		manifest.projection = {
			...manifest.projection,
			providers: {
				"openai-codex": {
					kind: "openai-compatible",
					auth: {
						type: "agent_profile",
						tool: "codex",
						profile: "default",
						credentialSecretRef: "secret://provider.openai-codex.oauthProfile",
						credentialRevision: "oauth-revision-1",
					},
				},
			},
		};
		expect(
			runtimeInstallerMutationTargets(
				manifest,
				home,
				new Map([
					["openclaw", { status: "present" as const }],
					["hermes", { status: "present" as const }],
				]),
			).sort(),
		).toEqual([join(home, ".openclaw", "bin"), join(home, ".openclaw", "tools")].sort());
	});

	test("accepts an installed runtime command symlink as an exact transaction target", () => {
		const paths = tempRuntimePaths();
		const appRoot = join(paths.userHome, ".openclaw");
		const commandPath = join(appRoot, "bin", "openclaw");
		const commandTarget = join(appRoot, "openclaw-entrypoint");
		mkdirSync(dirname(commandPath), { recursive: true });
		writeFileSync(commandTarget, "#!/bin/sh\nexit 0\n");
		chmodSync(commandTarget, 0o755);
		symlinkSync(commandTarget, commandPath);
		const manifest = baseManifest(paths, {
			openclaw: {
				enabled: true,
				install: {
					authority: "official",
					method: "official-installer",
					url: OFFICIAL_INSTALL_URLS.openclaw,
					home: paths.userHome,
					args: [...OFFICIAL_INSTALL_ARGS.openclaw],
				},
				run: runSettings(commandPath, ["gateway", "run"]),
				services: {},
			},
		});

		const result = convergeRuntimeManifest(manifestLoad(manifest, "symlinked-openclaw"), paths);
		expect(result.installErrors).toEqual([]);
		expect(readlinkSync(commandPath)).toBe(commandTarget);
	});

	test("repairs root bootstrap ownership for the UID 10001 official OpenClaw service path", () => {
		if (process.geteuid?.() !== 0 || !existsSync("/usr/bin/setpriv")) return;
		const paths = tempRuntimePaths();
		const fixtureRoot = dirname(paths.serviceStateRoot);
		const runtimeUid = 10_001;
		const runtimeGid = 10_001;
		const appRoot = join(paths.userHome, ".openclaw");
		const binDir = join(appRoot, "bin");
		const commandPath = join(binDir, "openclaw");
		const gatewayEnvironment = join(appRoot, "gateway.systemd.env");
		const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
		const unitBackupPath = `${unitPath}.bak`;
		const runtimeOwnedPaths = [
			appRoot,
			binDir,
			commandPath,
			dirname(dirname(paths.systemdUserRoot)),
			dirname(paths.systemdUserRoot),
			paths.systemdUserRoot,
			unitPath,
			unitBackupPath,
			gatewayEnvironment,
		];

		chmodSync(fixtureRoot, 0o755);
		mkdirSync(paths.userHome, { recursive: true });
		chownSync(paths.userHome, runtimeUid, runtimeGid);
		chmodSync(paths.userHome, 0o700);
		mkdirSync(paths.clawdiHome, { recursive: true });
		chownSync(paths.clawdiHome, runtimeUid, runtimeGid);
		chmodSync(paths.clawdiHome, 0o700);
		mkdirSync(binDir, { recursive: true });
		mkdirSync(dirname(unitPath), { recursive: true });
		writeFileSync(
			commandPath,
			`#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = "10001"
test "$*" = "gateway install --force --json"
unit="$HOME/.config/systemd/user/\${OPENCLAW_SYSTEMD_UNIT:-openclaw-gateway.service}"
cp "$unit" "$unit.bak"
printf '%s\\n' '[Unit]' '[Service]' 'ExecStart=openclaw gateway run' > "$unit"
printf '%s\\n' 'OPENCLAW_OFFICIAL_USER_STATE=1' > "$HOME/.openclaw/gateway.systemd.env"
chmod 0600 "$HOME/.openclaw/gateway.systemd.env"
printf '{"ok":true}\\n'
`,
		);
		writeFileSync(unitPath, "[Unit]\nDescription=previous official unit\n");
		writeFileSync(unitBackupPath, "previous official backup\n");
		writeFileSync(gatewayEnvironment, "PREVIOUS_OFFICIAL_STATE=1\n");
		for (const path of [appRoot, binDir]) {
			chownSync(path, 0, 0);
			chmodSync(path, 0o700);
		}
		for (const path of [commandPath, unitPath, unitBackupPath, gatewayEnvironment]) {
			chownSync(path, 0, 0);
			chmodSync(path, 0o700);
		}
		chmodSync(unitPath, 0o600);
		chmodSync(unitBackupPath, 0o600);
		chmodSync(gatewayEnvironment, 0o600);

		process.env.CLAWDI_RUNTIME_USER = "clawdi";
		process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
		process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);
		const manifest = baseManifest(paths, {
			openclaw: {
				enabled: true,
				install: {
					authority: "official",
					method: "official-installer",
					url: OFFICIAL_INSTALL_URLS.openclaw,
					home: paths.userHome,
					args: [...OFFICIAL_INSTALL_ARGS.openclaw],
				},
				run: runSettings(commandPath, ["gateway", "run"]),
				services: {},
			},
		});

		const result = convergeRuntimeManifest(
			manifestLoad(manifest, "root-openclaw-ownership"),
			paths,
			{
				executeOfficialServiceInstallers: false,
			},
		);
		expect(result.installErrors).toEqual([]);
		for (const path of runtimeOwnedPaths) {
			const node = statSync(path);
			expect([node.uid, node.gid]).toEqual([runtimeUid, runtimeGid]);
		}
		expect(statSync(appRoot).mode & 0o777).toBe(0o700);
		expect(statSync(commandPath).mode & 0o777).toBe(0o700);
		expect(statSync(gatewayEnvironment).mode & 0o777).toBe(0o600);
		expect([statSync(paths.daemonAuthToken).uid, statSync(paths.daemonAuthToken).gid]).toEqual([
			0, 0,
		]);
		expect(statSync(paths.daemonAuthToken).mode & 0o777).toBe(0o600);

		const installed = execFileSync(
			"/usr/bin/setpriv",
			[
				`--reuid=${runtimeUid}`,
				`--regid=${runtimeGid}`,
				"--clear-groups",
				"env",
				`HOME=${paths.userHome}`,
				"OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service",
				commandPath,
				"gateway",
				"install",
				"--force",
				"--json",
			],
			{ cwd: paths.userHome, encoding: "utf8" },
		);
		expect(JSON.parse(installed)).toEqual({ ok: true });
		expect(statSync(unitPath).uid).toBe(runtimeUid);
		expect(statSync(unitBackupPath).uid).toBe(runtimeUid);
		expect(statSync(gatewayEnvironment).uid).toBe(runtimeUid);
		expect(statSync(gatewayEnvironment).mode & 0o777).toBe(0o600);

		for (const path of runtimeOwnedPaths) chownSync(path, 0, 0);
		const beforeRollback = new Map(
			runtimeOwnedPaths.map(
				(path) =>
					[
						path,
						{
							content: statSync(path).isFile() ? readFileSync(path) : null,
							mode: statSync(path).mode & 0o777,
						},
					] as const,
			),
		);
		const failed = convergeRuntimeManifest(
			manifestLoad({ ...manifest, generation: 2 }, "root-openclaw-ownership-rollback"),
			paths,
			{
				cacheLastGood: false,
				commitAuthority: () => {
					throw new Error("injected ownership commit failure");
				},
				executeOfficialServiceInstallers: false,
			},
		);
		expect(failed.installErrors.join("\n")).toContain("injected ownership commit failure");
		for (const [path, previous] of beforeRollback) {
			const node = statSync(path);
			expect([node.uid, node.gid]).toEqual([0, 0]);
			expect(node.mode & 0o777).toBe(previous.mode);
			if (previous.content) expect(readFileSync(path)).toEqual(previous.content);
		}
		expect([statSync(paths.daemonAuthToken).uid, statSync(paths.daemonAuthToken).gid]).toEqual([
			0, 0,
		]);
		expect(statSync(paths.daemonAuthToken).mode & 0o777).toBe(0o600);
	});

	test("restores exact installer targets and reconciles the planned units after installer failure", () => {
		const paths = tempRuntimePaths();
		const home = paths.userHome;
		const binDir = join(home, ".openclaw", "bin");
		const toolsDir = join(home, ".openclaw", "tools");
		const existingBinFile = join(binDir, "keep.txt");
		const existingToolFile = join(toolsDir, "cache", "keep.txt");
		const commandPath = join(binDir, "openclaw");
		const installerPath = join(dirname(home), "openclaw-failing-installer.sh");
		const installerLog = join(dirname(home), "openclaw-failing-installer.log");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(dirname(existingToolFile), { recursive: true });
		writeFileSync(existingBinFile, "original-bin\n");
		writeFileSync(existingToolFile, "original-tool\n");
		chmodSync(binDir, 0o750);
		chmodSync(toolsDir, 0o700);
		chmodSync(existingBinFile, 0o640);
		chmodSync(existingToolFile, 0o600);
		writeFileSync(
			installerPath,
			`#!/usr/bin/env bash
set -euo pipefail
printf 'ran\n' > '${installerLog}'
chmod 0777 '${binDir}' '${toolsDir}'
printf 'mutated-bin\n' > '${existingBinFile}'
rm -f '${existingToolFile}'
printf '#!/bin/sh\nexit 0\n' > '${commandPath}'
chmod 0755 '${commandPath}'
printf 'new-tool\n' > '${join(toolsDir, "new.txt")}'
exit 42
`,
		);
		chmodSync(installerPath, 0o700);
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = installerPath;
		const manifest = baseManifest(paths, {
			openclaw: {
				enabled: true,
				install: {
					authority: "official",
					method: "official-installer",
					url: OFFICIAL_INSTALL_URLS.openclaw,
					home,
					args: OFFICIAL_INSTALL_ARGS.openclaw ?? [],
				},
				run: runSettings(commandPath, ["gateway", "run"]),
				services: {},
			},
		});
		let activateCalls = 0;
		let rollbackSignal: {
			reconcileUserUnits: string[];
			staleSystemUnits: string[];
			staleUserUnits: string[];
		} | null = null;
		const result = convergeRuntimeManifest(manifestLoad(manifest, "installer-failure"), paths, {
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: () => {
					activateCalls += 1;
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
				rollback: (signal) => {
					rollbackSignal = signal;
				},
			},
		});

		expect(result.installErrors.join("\n")).toContain("runtime openclaw installer exited 42");
		expect(readFileSync(installerLog, "utf8")).toBe("ran\n");
		expect(activateCalls).toBe(0);
		expect(rollbackSignal).toMatchObject({
			reconcileUserUnits: ["openclaw-gateway.service"],
			staleSystemUnits: [],
			staleUserUnits: [],
		});
		expect(readFileSync(existingBinFile, "utf8")).toBe("original-bin\n");
		expect(readFileSync(existingToolFile, "utf8")).toBe("original-tool\n");
		expect(existsSync(commandPath)).toBe(false);
		expect(existsSync(join(toolsDir, "new.txt"))).toBe(false);
		expect(statSync(binDir).mode & 0o777).toBe(0o750);
		expect(statSync(toolsDir).mode & 0o777).toBe(0o700);
		expect(statSync(existingBinFile).mode & 0o777).toBe(0o640);
		expect(statSync(existingToolFile).mode & 0o777).toBe(0o600);
	});

	test("captures and restores declared systemd enablement symlink targets", () => {
		const paths = tempRuntimePaths();
		const unitName = "openclaw-gateway.service";
		const unitPath = join(paths.systemdUserRoot, unitName);
		const enablementPath = join(paths.systemdUserRoot, "default.target.wants", unitName);
		mkdirSync(dirname(enablementPath), { recursive: true });
		writeFileSync(unitPath, "[Service]\nExecStart=/bin/true\n");
		symlinkSync(`../${unitName}`, enablementPath);

		const snapshot = captureRuntimeLiveSnapshot({
			rootTargets: [],
			trustedRootDirectories: [],
			runtimeUserTargets: [enablementPath],
			runtimeUserTrustedRoots: [paths.userHome],
			runtimeUserSymlinkTargets: [enablementPath],
			metadataTargets: [],
		});
		rmSync(enablementPath);
		symlinkSync("../unexpected.service", enablementPath);

		restoreRuntimeLiveSnapshot(snapshot);
		expect(readlinkSync(enablementPath)).toBe(`../${unitName}`);
	});

	test("rejects symlinked installer targets before running the external installer", () => {
		const paths = tempRuntimePaths();
		const home = paths.userHome;
		const openclawRoot = join(home, ".openclaw");
		const redirectedTools = join(dirname(home), "redirected-openclaw-tools");
		const installerPath = join(dirname(home), "must-not-run-installer.sh");
		const installerLog = join(dirname(home), "must-not-run-installer.log");
		mkdirSync(openclawRoot, { recursive: true });
		mkdirSync(redirectedTools, { recursive: true });
		symlinkSync(redirectedTools, join(openclawRoot, "tools"));
		writeFileSync(installerPath, `#!/bin/sh\nprintf ran > '${installerLog}'\nexit 0\n`);
		chmodSync(installerPath, 0o700);
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = installerPath;
		const manifest = baseManifest(paths, {
			openclaw: {
				enabled: true,
				install: {
					authority: "official",
					method: "official-installer",
					url: OFFICIAL_INSTALL_URLS.openclaw,
					home,
					args: OFFICIAL_INSTALL_ARGS.openclaw ?? [],
				},
				run: runSettings(join(openclawRoot, "bin", "openclaw"), ["gateway", "run"]),
				services: {},
			},
		});

		expect(() =>
			convergeRuntimeManifest(manifestLoad(manifest, "symlinked-installer-target"), paths),
		).toThrow(`runtime-user mutation path contains a symlink: ${join(openclawRoot, "tools")}`);
		expect(existsSync(installerLog)).toBe(false);
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
			{
				projection: {
					mcp: { servers: { clawdi: { command: "clawdi", args: ["mcp"] } } },
				},
			},
		);

		expect(() =>
			convergeRuntimeManifest(manifestLoad(manifest, "inline-hermes-patch-failure"), paths),
		).toThrow(/config field mcp_servers must be an object/);
		expect(readFileSync(hermesConfig)).toEqual(previousConfig);
		expect(readFileSync(paths.managedConfig)).toEqual(previousManaged);
	});

	test("rolls back managed state when the authority commit fails", () => {
		const paths = tempRuntimePaths();
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

	test("resolves runtime secret refs only by exact canonical secret:// keys", () => {
		expect(
			runtimeSecretValue(
				{ "secret://providers/default/api-key": "sk-exact" },
				"secret://providers/default/api-key",
			),
		).toBe("sk-exact");
		expect(runtimeSecretValue({}, "secret://providers/default/api-key")).toBeNull();
		expect(runtimeSecretValue({}, "providers/default/api-key")).toBeNull();
		expect(() => normalizeSecretValues({ "env://CLAWDI_AUTH_TOKEN": "deployment-token" })).toThrow(
			"runtime secret value key must be a canonical secret:// reference",
		);
		expect(() => normalizeSecretValues({ "providers/default/api-key": "sk-alias" })).toThrow(
			"runtime secret value key must be a canonical secret:// reference",
		);
	});

	test("uses bundle secretValues instead of stale process env", () => {
		process.env.OPENCLAW_GATEWAY_TOKEN = "stale-process-token";
		const projected = normalizeSecretValues({
			"secret://runtime/openclaw/gateway-token": "bundle-token",
		});
		expect(runtimeSecretValue(projected, "secret://runtime/openclaw/gateway-token")).toBe(
			"bundle-token",
		);
		expect(runtimeSecretValue(projected, "env://OPENCLAW_GATEWAY_TOKEN")).toBeNull();
	});

	test("rejects direct convergence without an explicit apply context", () => {
		const paths = tempRuntimePaths();
		const load = manifestLoad(
			baseManifest(paths, {
				openclaw: { enabled: false, run: runSettings("openclaw", []), services: {} },
			}),
			"inline-missing-apply-context",
		);
		expect(() => convergeRuntimeManifest({ ...load, applyContext: undefined }, paths)).toThrow(
			"runtime manifest convergence requires an explicit apply context",
		);
	});
});
