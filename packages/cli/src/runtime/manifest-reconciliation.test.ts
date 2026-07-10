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

function tempRuntimePaths(): RuntimePaths {
	const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-reconcile-test-"));
	tempRoots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "run", "systemd", "system");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	process.env.CLAWDI_HOME = join(root, "clawdi-home");
	process.env.CLAWDI_AUTH_TOKEN = "test-token";
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
	test("normalizes hosted manifest responses into runtime desired state without embedding secrets", () => {
		const hostedResponse = {
			manifest: {
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				runtime: "openclaw",
				deploymentId: "hdep_normalize",
				environmentId: "env_normalize",
				instanceId: "hri_normalize",
				generation: 7,
				issuedAt: "2026-07-01T00:00:00.000Z",
				system: {
					home: "/home/clawdi-test",
					workspace: "/workspace/clawdi",
				},
				controlPlane: {
					cloudApiUrl: "https://cloud-api.example.test",
					manifestUrl: "https://cloud-api.example.test/v1/runtime/manifest",
				},
				runtimes: {
					openclaw: {
						enabled: true,
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
				mitmProfiles: {
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
		expect(normalized.manifest.mitmProfiles?.profiles.map((profile) => profile.id)).toContain(
			"api-proxy",
		);
		expect(normalized.manifest.liveSync).toEqual(hostedResponse.manifest.liveSync);
		expect("secretValues" in normalized.manifest).toBe(false);
		expect(normalized.secretValues).toEqual({
			"providers/default/api-key": "sk-normalized",
			"secret://providers/default/api-key": "sk-normalized",
		});
	});

	test("infers the hosted runtime when the manifest has one runtime entry", () => {
		const hostedManifest = hostedRuntimeManifestSchema.parse({
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			deploymentId: "hdep_infer_runtime",
			environmentId: "env_infer_runtime",
			instanceId: "hri_infer_runtime",
			generation: 1,
			issuedAt: "2026-07-07T00:00:00.000Z",
			controlPlane: {
				cloudApiUrl: "https://cloud-api.example.test",
			},
			runtimes: {
				openclaw: {
					enabled: true,
					install: { source: "official" },
				},
			},
		});

		expect(hostedManifest.runtime).toBe("openclaw");
		expect(hostedManifestToRuntimeManifest(hostedManifest).runtime).toBe("openclaw");
	});

	test("strips unknown hosted manifest fields while preserving the known contract", () => {
		const cleanManifest = {
			schemaVersion: "clawdi.hosted-runtime.manifest.v1",
			runtime: "openclaw",
			deploymentId: "hdep_forward_compat",
			environmentId: "env_forward_compat",
			instanceId: "hri_forward_compat",
			generation: 1,
			issuedAt: "2026-07-01T00:00:00.000Z",
			controlPlane: {
				cloudApiUrl: "https://cloud-api.example.test",
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

		const parsed = hostedRuntimeManifestSchema.parse({
			...cleanManifest,
			futureTopLevelField: { deployApiCanShipFirst: true },
			runtimes: {
				openclaw: {
					...cleanManifest.runtimes.openclaw,
					futureRuntimeField: "ignored",
					run: {
						...cleanManifest.runtimes.openclaw.run,
						futureRunField: "ignored",
					},
				},
			},
		});

		expect(parsed).toEqual(hostedRuntimeManifestSchema.parse(cleanManifest));
		expect(parsed).not.toHaveProperty("futureTopLevelField");
		expect(parsed.runtimes.openclaw).not.toHaveProperty("futureRuntimeField");
		expect(parsed.runtimes.openclaw.run).not.toHaveProperty("futureRunField");
	});

	test("rejects hosted manifests that still declare multiple execution runtimes", () => {
		expect(() =>
			hostedRuntimeManifestSchema.parse({
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				runtime: "openclaw",
				deploymentId: "hdep_multi",
				environmentId: "env_multi",
				instanceId: "hri_multi",
				generation: 1,
				issuedAt: "2026-07-01T00:00:00.000Z",
				controlPlane: {
					cloudApiUrl: "https://cloud-api.example.test",
				},
				runtimes: {
					openclaw: {
						enabled: true,
						run: { command: "openclaw", args: ["gateway", "run"] },
					},
					hermes: {
						enabled: true,
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
							// through the MITM placeholder path — the agent env gets the
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
		expect(runConfig.env?.OPENAI_API_KEY).toBe("clawdi-mitm-placeholder");
		const envFile = readFileSync(
			join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
			"utf8",
		);
		expect(envFile).not.toContain("CLAWDI_MANAGED_OPENAI_API_KEY");
		expect(envFile).toContain('OPENAI_API_KEY="clawdi-mitm-placeholder"');
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
		expect(runtimeSidecarProgramRevision(metadataOnlyChange, secretValues)).toBe(sidecarRevision);
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
