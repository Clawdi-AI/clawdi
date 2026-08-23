import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	cpSync,
	existsSync,
	lchownSync,
	lstatSync,
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
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { commitRuntimeAppliedState } from "../commands/runtime";
import {
	type TestConvergeOptions,
	withTestSystemdTransaction,
} from "../test-support/systemd-apply";
import {
	readRuntimeAppliedState,
	runtimeContentSha256,
	writeRuntimeAppliedState,
} from "./applied-state";
import { gcFileBrowserCompanionCandidates } from "./file-browser-companion";
import {
	hostedAgentPluginReceiptsPath,
	type PreparedHostedAgentPlugin,
	type PreparedHostedAgentPlugins,
} from "./hosted-agent-plugin-package";
import {
	type HostedAgentPluginCommandRunner,
	hostedAgentPluginCommands,
} from "./hosted-agent-plugin-runtime";
import {
	assertHostedBundledSkillCatalogDigest,
	resolveHostedBundledSkill,
} from "./hosted-bundled-skill";
import { hostedAiProviderCatalog } from "./hosted-provider-resolution";
import type { PreparedHostedSkill } from "./hosted-sourced-skill-archive";
import { readRuntimeInstallReceipts } from "./install-receipts";
import {
	captureRuntimeLiveSnapshot,
	restoreRuntimeLiveSnapshot,
	runtimeRootLiveMutationTargets,
} from "./live-state-snapshot";
import {
	managedSkillReservationLedgerPath,
	managedSkillReservationState,
	reserveManagedSkill,
	shouldIgnoreUserSkill,
} from "./managed-skill-reservation";
import {
	cacheRuntimeLastGoodManifest,
	convergeRuntimeManifest as convergeRuntimeManifestWithContract,
	planHostedAgentPluginConvergence,
	type RuntimeManifest,
	type RuntimePrivateAppliedAuthority,
	runtimeInstallerMutationTargets,
	runtimeRecoverableSecretValues,
	runtimeUserMutationTargets,
} from "./manifest";
import {
	AGENT_PLUGIN_HOSTED_V2_REQUIRED_ERROR,
	AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR,
	fileBrowserCompanionSchema,
	hostedRuntimeBundleV2ManifestSchema,
	hostedRuntimeManifestSchema,
	manifestSchema,
	OFFICIAL_INSTALL_URLS,
	officialInstallArgs,
} from "./manifest-contract";
import {
	AGENT_PLUGINS_SCHEMA_1_0_0,
	type HostedAgentPluginsDesiredState,
	type HostedSkillSource,
} from "./manifest-resources";
import {
	hostedManifestToRuntimeManifest,
	loadCommittedRuntimeManifest,
	normalizeHostedRuntimeBundleV2,
	type RuntimeManifestLoad,
} from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { type RuntimeRunSettings, runtimeRunConfigPath } from "./run-config";
import { planRuntimeMutationSystemdUserUnits } from "./runtime-systemd-reconciliation";
import {
	canonicalSecretRefSchema,
	normalizeSecretValues,
	runtimeSecretValue,
} from "./secret-values";
import { ensureRuntimeStateDirs } from "./state";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";

const successfulPrerequisiteActivation = () => ({
	applied: true,
	systemUnitsChanged: [],
	userUnitsChanged: [],
});

const originalEnv = { ...process.env };
const tempRoots: string[] = [];
const TEST_HOSTED_LOCALE = { language: "en" as const, timezone: "UTC" };
const TEST_HOSTED_HOME = "/home/clawdi";
const TEST_PROCESS_UID = process.getuid?.() ?? 1_000;
const TEST_PROCESS_GID = process.getgid?.() ?? 1_000;
const TEST_RUNTIME_USER = String(TEST_PROCESS_UID);
const HERMES_CONFIG_CLI_MOCK = fileURLToPath(
	new URL("../test-support/hermes-config-cli-mock.ts", import.meta.url),
);
const HERMES_TEST_PROVIDER_TOKEN_REF = `\${HERMES_TEST_PROVIDER_TOKEN}`;
const FILE_BROWSER_VERSION = "v1.5.0-stable";
const FILE_BROWSER_COMMIT = "79552f8adb27c3e29934c4001660eb98f4aab5d6";
const FILE_BROWSER_AMD64_SHA256 =
	"8d51d1718d576d22e73e1f41a5194b451d152ddab0df97697cabe839cf59524e";
const FILE_BROWSER_ARM64_SHA256 =
	"3e18838ae33750a25da434dc6156a359968bf7935e01bdd884711f47f08ad92f";
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
			runtimeEnvName: "CLAWDI_AI_API_KEY",
			apiKeySecretRef: "secret://tool.codex.apiKey",
		},
	},
};
const TEST_AGENT_PLUGIN_INSTALLATION: HostedAgentPluginsDesiredState["installations"][string] = {
	installationId: "install_01hxyz",
	version: "1.2.3-rc.1+linux",
	agentPluginsSchema: AGENT_PLUGINS_SCHEMA_1_0_0,
	source: {
		type: "github",
		url: "https://github.com/acme/agent-plugins",
		path: "plugins/acme.tools",
		commit: "a".repeat(40),
	},
	contentDigest: `sha256-tree-v1:${"b".repeat(64)}`,
};
const TEST_AGENT_PLUGINS: HostedAgentPluginsDesiredState = {
	schemaVersion: 1,
	installations: { "acme.tools": TEST_AGENT_PLUGIN_INSTALLATION },
};
function preparedTestAgentPlugin(
	name: string,
	version: string,
	ownershipIdentity: string,
): PreparedHostedAgentPlugin {
	const bytes = Buffer.from(JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_1_0_0, name, version }));
	const fileDigest = createHash("sha256").update(bytes).digest("hex");
	const treeDigest = createHash("sha256")
		.update(`100644\0plugin.json\0${bytes.byteLength}\0${fileDigest}\n`)
		.digest("hex");
	return {
		name,
		installation: {
			installationId: `install_${ownershipIdentity.slice(0, 8)}`,
			version,
			agentPluginsSchema: AGENT_PLUGINS_SCHEMA_1_0_0,
			source: {
				type: "github",
				url: "https://github.com/acme/agent-plugins",
				path: `plugins/${name}`,
				commit: ownershipIdentity.slice(0, 40),
			},
			contentDigest: `sha256-tree-v1:${treeDigest}`,
			ownershipIdentity,
		},
		mcpServerNames: [],
		hasStreamableHttpMcp: false,
		tree: [{ path: "plugin.json", mode: 0o100644, bytes }],
	};
}

function testAgentPluginDesiredState(
	prepared: PreparedHostedAgentPlugin,
): HostedAgentPluginsDesiredState {
	const { ownershipIdentity: _ownershipIdentity, ...installation } = prepared.installation;
	return {
		schemaVersion: 1,
		installations: { [prepared.name]: installation },
	};
}

function preparedTestAgentPluginState(
	desired: PreparedHostedAgentPlugin,
	previous?: PreparedHostedAgentPlugin,
): PreparedHostedAgentPlugins {
	return {
		runtime: "openclaw",
		desired: new Map([[desired.name, desired]]),
		previous: previous
			? new Map([
					[
						previous.name,
						{
							runtime: "openclaw" as const,
							name: previous.name,
							installation: previous.installation,
							nativeId: previous.name.replaceAll(".", "-"),
						},
					],
				])
			: new Map(),
		transientCacheOwnerships: new Set(),
	};
}

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
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_RUNTIME_USER = TEST_RUNTIME_USER;
	process.env.CLAWDI_HOME = join(root, "clawdi-home");
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
	return getRuntimePaths({ mode: "hosted" });
}

function preparedTestSourcedSkill(
	skillId: string,
	source: HostedSkillSource,
	skillMd: string,
): PreparedHostedSkill & {
	identity: { source: HostedSkillSource; sourceIdentity: string; digest: string };
	tarBytes: Buffer;
} {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "clawdi-prepared-skill-test-"));
	tempRoots.push(fixtureRoot);
	const sourceRoot = join(fixtureRoot, "source");
	const sourceDir = join(sourceRoot, skillId);
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(join(sourceDir, "SKILL.md"), skillMd);
	const archive = join(fixtureRoot, "skill.tar.gz");
	execFileSync("tar", ["-czf", archive, "-C", sourceRoot, skillId]);
	const tarBytes = readFileSync(archive);
	const sourceIdentity =
		source.type === "github"
			? ["github", skillId, source.url, source.path, source.commit].join("\0")
			: ["project", skillId, source.projectId, source.contentHash].join("\0");
	return {
		id: skillId,
		identity: {
			source,
			sourceIdentity,
			digest: createHash("sha256").update(tarBytes).digest("hex"),
		},
		tarBytes,
	};
}

function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: TestConvergeOptions = {},
) {
	ensureRuntimeStateDirs(paths);
	return convergeRuntimeManifestWithContract(load, paths, {
		...opts,
		systemdApply: opts.systemdApply ? withTestSystemdTransaction(opts.systemdApply) : undefined,
		hostedRuntimeContract: opts.hostedRuntimeContract ?? {
			expectedIdentity: {
				home: paths.userHome,
				user: TEST_RUNTIME_USER,
				uid: TEST_PROCESS_UID,
				gid: TEST_PROCESS_GID,
			},
			resolveUserIdentity: () => ({ uid: TEST_PROCESS_UID, gid: TEST_PROCESS_GID }),
		},
	});
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
			backend: "incus",
			identity: {
				generation: manifest.applyGeneration ?? manifest.generation,
				manifestETag: `"test-${manifest.generation}"`,
				applyReceiptId: "test-apply-receipt",
				bootNonce: "test-boot-nonce",
			},
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
	const commandPath = join(paths.userHome, ".local", "bin", "openclaw");
	writeFakeGatewayCli({
		path: commandPath,
		runtime: "openclaw",
		unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
	});
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
	authority: RuntimePrivateAppliedAuthority,
): void {
	commitRuntimeAppliedState({
		load,
		paths,
		etag: `"generation-${load.manifest.generation}"`,
		sourceRevision: runtimeContentSha256({ generation: load.manifest.generation }),
		convergence,
		applyIdentity: null,
		daemonAuthTokenRevision: authority.daemonAuthTokenRevision,
		daemonProgramRevision: authority.daemonProgramRevision,
		egressSidecarSecretRevision: authority.egressSidecarSecretRevision,
	});
}

function hostedManifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "clawdi.hosted-runtime.manifest.v1",
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
			packageSpec: "clawdi@1.2.3-test",
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
					args: ["gateway", "run"],
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
			args: ["gateway", "run"],
			secretEnv: {
				OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
			},
		},
		...overrides,
	};
}

function hostedHermesManifestFixture(
	overrides: Record<string, unknown> = {},
	gatewayArgs: string[] = ["gateway", "run"],
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
				run: { args: gatewayArgs },
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

const LEGACY_HOSTED_OPENCLAW_GATEWAY_RUN_ARGS = [
	"gateway",
	"run",
	"--allow-unconfigured",
	"--port",
	"18789",
	"--bind",
	"lan",
	"--force",
];

function hostedOpenClawV2ManifestFixture(
	overrides: Record<string, unknown> = {},
	gatewayArgs: string[] = ["gateway", "run"],
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
					args: gatewayArgs,
					secretEnv: {
						OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
					},
				},
			}),
		},
		...overrides,
	});
}

function normalizeHostedBundleFixture(
	manifest: Record<string, unknown>,
	secretValues: Record<string, string>,
): RuntimeManifestLoad {
	return normalizeHostedRuntimeBundleV2({
		schemaVersion: "clawdi.hosted-runtime.bundle.v2",
		sourceRevision: "a".repeat(64),
		manifest,
		channelBindings: [],
		secretValues,
	});
}

function writeFakeGatewayCli(input: {
	path: string;
	runtime: "openclaw" | "hermes";
	unitPath: string;
	configPatchPath?: string;
	failInstall?: boolean;
	skillInstallSourceLog?: string;
}): void {
	mkdirSync(dirname(input.path), { recursive: true });
	writeFileSync(
		input.path,
		`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
	"--version")
		printf '%s\\n' '${input.runtime === "openclaw" ? "OpenClaw test-version" : "Hermes test-version"}'
		;;
	"config patch --stdin"*)
		${input.configPatchPath ? `cat > '${input.configPatchPath}'` : "cat >/dev/null"}
		;;
	"config path"|"config get "*|"config set "*|"config unset "*)
		exec '${process.execPath}' '${HERMES_CONFIG_CLI_MOCK}' "$@"
		;;
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
EOF
    printf '%s\\n' '{"ok":true}'`
		}
    ;;
  "gateway uninstall")
    rm -f '${input.unitPath}'
    ;;
	  "agents list --json")
	    printf '[{"id":"main","workspace":"%s"}]\n' "$HOME/.openclaw/workspace"
	    ;;
	  "skills install "*)
	    source_dir="$3"
	    skill_id="$7"
	    ${input.skillInstallSourceLog ? `printf '%s\\n' "$source_dir" > '${input.skillInstallSourceLog}'` : ""}
	    workspace="$HOME/.openclaw/workspace"
	    mkdir -p "$workspace/skills"
	    rm -rf "$workspace/skills/$skill_id"
	    cp -R "$source_dir" "$workspace/skills/$skill_id"
	    mkdir -p "$workspace/skills/$skill_id/.openclaw"
	    printf '{}\n' > "$workspace/skills/$skill_id/.openclaw/source-origin.json"
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

function writeFakeOpenClawConfigMutationSdk(home: string): string {
	const packageRoot = join(home, ".local", "lib", "node_modules", "openclaw");
	const configPath = join(home, ".openclaw", "openclaw.json");
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, "{}\n");
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({
			name: "openclaw",
			type: "module",
			exports: { "./plugin-sdk/config-mutation": "./config-mutation.mjs" },
		}),
	);
	writeFileSync(
		join(packageRoot, "config-mutation.mjs"),
		`import { readFileSync, writeFileSync } from "node:fs";
const configPath = ${JSON.stringify(configPath)};
export async function readConfigFileSnapshotForWrite() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return { snapshot: { valid: true, config, sourceConfig: structuredClone(config) } };
}
export async function mutateConfigFile(options) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  await options.mutate(config, { snapshot: {}, previousHash: null, attempt: 1 });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
}
`,
	);
	return configPath;
}

type FileBrowserCompanion = NonNullable<NonNullable<RuntimeManifest["companions"]>["filebrowser"]>;

function fileBrowserCompanion(accessRevision = "a".repeat(64)): FileBrowserCompanion {
	const audience = "clawdi-files:hdep_files_reconcile";
	return {
		version: FILE_BROWSER_VERSION,
		commit: FILE_BROWSER_COMMIT,
		listen: "0.0.0.0",
		port: 9120,
		baseURL: "/",
		healthPath: "/health",
		sourceRoot: "/home/clawdi",
		assets: {
			amd64: {
				url: `https://github.com/gtsteffaniak/filebrowser/releases/download/${FILE_BROWSER_VERSION}/linux-amd64-filebrowser`,
				sha256: FILE_BROWSER_AMD64_SHA256,
			},
			arm64: {
				url: `https://github.com/gtsteffaniak/filebrowser/releases/download/${FILE_BROWSER_VERSION}/linux-arm64-filebrowser`,
				sha256: FILE_BROWSER_ARM64_SHA256,
			},
		},
		auth: {
			method: "jwt",
			algorithm: "HS256",
			header: "X-JWT-Assertion",
			userIdentifier: "sub",
			groupsClaim: "groups",
			secret: accessRevision.slice(0, 43),
			audience,
			subject: "deployment:hdep_files_reconcile:owner",
			requiredGroup: `${audience}:${accessRevision}`,
			accessRevision,
		},
	};
}

function fileBrowserBinaryPath(paths: RuntimePaths, binary: string): string {
	const sha256 = createHash("sha256").update(binary).digest("hex");
	return join(paths.fileBrowserInstallRoot, "candidates", sha256, "filebrowser");
}

function fileBrowserManifest(
	paths: RuntimePaths,
	input: { generation: number; binary: string; accessRevision?: string },
): RuntimeManifest {
	const command = join(paths.userHome, ".local", "bin", "openclaw");
	writeFakeGatewayCli({
		path: command,
		runtime: "openclaw",
		unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
	});
	const companion = fileBrowserCompanion(input.accessRevision);
	Reflect.set(
		companion.assets.amd64,
		"sha256",
		createHash("sha256").update(input.binary).digest("hex"),
	);
	return baseManifest(
		paths,
		{
			openclaw: {
				enabled: true,
				run: runSettings(command, ["gateway", "run"]),
				services: {},
			},
		},
		{
			generation: input.generation,
			issuedAt: `2026-08-05T00:00:${String(input.generation).padStart(2, "0")}.000Z`,
			openclawGatewayAuth: hostedOpenClawNativeAuth(),
			projection: {
				sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
				system: hostedSystemFixture(),
			},
			companions: { filebrowser: companion },
		},
	);
}

function fileBrowserManifestLoad(manifest: RuntimeManifest): RuntimeManifestLoad {
	const load = manifestLoad(manifest, `files-generation-${manifest.generation}`);
	if (!load.applyContext) throw new Error("Files test apply context is missing");
	return {
		...load,
		applyContext: { ...load.applyContext, backend: "incus" },
	};
}

function fileBrowserApplyHooks(
	input: {
		activationApplied?: boolean;
		onActivate?: () => void;
		onQuiesce?: () => void;
		onRollback?: () => void;
	} = {},
) {
	return {
		quiesce: () => input.onQuiesce?.(),
		activateEgressPrerequisite: successfulPrerequisiteActivation,
		activate: () => {
			input.onActivate?.();
			return {
				applied: input.activationApplied ?? true,
				systemUnitsChanged: [],
				userUnitsChanged: [],
			};
		},
		rollback: () => input.onRollback?.(),
	};
}

const testFileBrowserServiceIsolation = () => ({
	uid: typeof process.geteuid === "function" ? process.geteuid() : 0,
	gid: typeof process.getegid === "function" ? process.getegid() : 0,
});

afterEach(() => {
	process.env = { ...originalEnv };
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime manifest reconciliation invariants", () => {
	test.each([
		["OpenClaw", hostedOpenClawV2ManifestFixture()],
		["Hermes", hostedHermesManifestFixture()],
	] as const)(
		"rejects the removed bridge field in every hosted %s manifest schema",
		(_name, valid) => {
			expect(hostedRuntimeManifestSchema.safeParse(valid).success).toBe(true);
			expect(hostedRuntimeBundleV2ManifestSchema.safeParse(valid).success).toBe(true);
			const withBridge = { ...valid, bridge: {} };
			expect(hostedRuntimeManifestSchema.safeParse(withBridge).success).toBe(false);
			expect(hostedRuntimeBundleV2ManifestSchema.safeParse(withBridge).success).toBe(false);
		},
	);

	test("requires typed native token auth for hosted OpenClaw v2", () => {
		const valid = hostedOpenClawV2ManifestFixture();
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(valid).success).toBe(true);

		const missingAuth = structuredClone(valid);
		delete (missingAuth.system as { openclawGatewayAuth?: unknown }).openclawGatewayAuth;
		const missingAuthResult = hostedRuntimeBundleV2ManifestSchema.safeParse(missingAuth);
		expect(missingAuthResult.success).toBe(false);
		expect(
			missingAuthResult.error?.issues.some(
				(issue) => issue.message === "OpenClaw native auth activation must be explicitly enabled",
			),
		).toBe(false);

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
		const missingOrigin = structuredClone(valid);
		(
			missingOrigin.system as { openclawControlUiAllowedOrigins: string[] }
		).openclawControlUiAllowedOrigins = [];
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(missingOrigin).success).toBe(false);
	});

	test("keeps hosted runtime process ownership on the exact upstream commands", () => {
		for (const manifest of [hostedOpenClawV2ManifestFixture(), hostedHermesManifestFixture()]) {
			const runtime = manifest.runtime as "openclaw" | "hermes";
			delete (manifest.runtimes as Record<string, { run?: unknown }>)[runtime].run;
			expect(hostedRuntimeBundleV2ManifestSchema.safeParse(manifest).success).toBe(false);
		}

		for (const [field, value] of [
			["command", "openclaw"],
			["cwd", "/home/clawdi"],
			["env", { EXTRA: "value" }],
			["prependPath", ["/custom/bin"]],
		] as const) {
			const manifest = hostedOpenClawV2ManifestFixture();
			const run = (manifest.runtimes as { openclaw: { run: Record<string, unknown> } }).openclaw
				.run;
			run[field] = value;
			expect(hostedRuntimeBundleV2ManifestSchema.safeParse(manifest).success).toBe(false);
		}

		const openClawService = hostedOpenClawV2ManifestFixture();
		(
			openClawService.runtimes as { openclaw: { services: Record<string, unknown> } }
		).openclaw.services = { helper: { args: ["helper"] } };
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(openClawService).success).toBe(false);

		const hermesService = hostedHermesManifestFixture();
		(
			hermesService.runtimes as { hermes: { services: Record<string, unknown> } }
		).hermes.services.helper = { args: ["helper"] };
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(hermesService).success).toBe(false);

		const hermesDashboardEnv = hostedHermesManifestFixture();
		const dashboard = (
			hermesDashboardEnv.runtimes as {
				hermes: { services: { dashboard: Record<string, unknown> } };
			}
		).hermes.services.dashboard;
		dashboard.env = { EXTRA: "value" };
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(hermesDashboardEnv).success).toBe(false);
	});

	test("normalizes previous gateway args during the official-unit rollout", () => {
		const legacy = hostedOpenClawV2ManifestFixture({}, LEGACY_HOSTED_OPENCLAW_GATEWAY_RUN_ARGS);
		expect(hostedRuntimeManifestSchema.safeParse(legacy).success).toBe(true);
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(legacy).success).toBe(true);
		const legacyHermes = hostedRuntimeBundleV2ManifestSchema.parse(
			hostedHermesManifestFixture({}, ["gateway", "run", "--replace"]),
		);
		expect(hostedManifestToRuntimeManifest(legacyHermes).runtimes.hermes.run?.args).toEqual([
			"gateway",
			"run",
		]);

		const unsupported = hostedOpenClawV2ManifestFixture({}, ["gateway", "run", "--force"]);
		expect(hostedRuntimeBundleV2ManifestSchema.safeParse(unsupported).success).toBe(false);
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

	test("strictly parses and preserves the Agent Plugins desired-state contract", () => {
		const parsed = hostedRuntimeBundleV2ManifestSchema.parse(
			hostedManifestFixture({ agentPlugins: TEST_AGENT_PLUGINS }),
		);
		expect(parsed.agentPlugins).toEqual(TEST_AGENT_PLUGINS);
		expect(hostedManifestToRuntimeManifest(parsed).projection?.agentPlugins).toEqual(
			TEST_AGENT_PLUGINS,
		);
		const maximumVersion = `1.2.3+${"a".repeat(250)}`;
		const maximumLengthPlugins = {
			...TEST_AGENT_PLUGINS,
			installations: {
				"acme.tools": { ...TEST_AGENT_PLUGIN_INSTALLATION, version: maximumVersion },
			},
		};
		expect(
			hostedRuntimeBundleV2ManifestSchema.parse(
				hostedManifestFixture({ agentPlugins: maximumLengthPlugins }),
			).agentPlugins,
		).toEqual(maximumLengthPlugins);

		const empty = hostedRuntimeBundleV2ManifestSchema.parse(
			hostedManifestFixture({ agentPlugins: { schemaVersion: 1, installations: {} } }),
		);
		expect(hostedManifestToRuntimeManifest(empty).projection?.agentPlugins).toEqual({
			schemaVersion: 1,
			installations: {},
		});
		expect(
			hostedManifestToRuntimeManifest(
				hostedRuntimeBundleV2ManifestSchema.parse(hostedManifestFixture()),
			).projection?.agentPlugins,
		).toBeUndefined();
	});

	test("rejects Agent Plugins on the legacy Hosted manifest v1 contract", () => {
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({ agentPlugins: TEST_AGENT_PLUGINS }),
			).success,
		).toBe(false);
	});

	test.each([
		["mutable version", { ...TEST_AGENT_PLUGIN_INSTALLATION, version: "^1.2.3" }],
		[
			"overlong version",
			{ ...TEST_AGENT_PLUGIN_INSTALLATION, version: `1.2.3+${"a".repeat(251)}` },
		],
		["noncanonical schema URI", { ...TEST_AGENT_PLUGIN_INSTALLATION, agentPluginsSchema: "1.0.0" }],
		[
			"mutable source",
			{
				...TEST_AGENT_PLUGIN_INSTALLATION,
				source: { ...TEST_AGENT_PLUGIN_INSTALLATION.source, commit: "main" },
			},
		],
		[
			"unsafe source path",
			{
				...TEST_AGENT_PLUGIN_INSTALLATION,
				source: { ...TEST_AGENT_PLUGIN_INSTALLATION.source, path: "plugins/../escape" },
			},
		],
		[
			"noncanonical digest",
			{ ...TEST_AGENT_PLUGIN_INSTALLATION, contentDigest: `sha256-tree-v1:${"B".repeat(64)}` },
		],
		[
			"unknown secret shape",
			{ ...TEST_AGENT_PLUGIN_INSTALLATION, secretValues: { "api-token": "plaintext" } },
		],
	] as const)("rejects Agent Plugins %s", (_name, installation) => {
		expect(
			hostedRuntimeBundleV2ManifestSchema.safeParse(
				hostedManifestFixture({
					agentPlugins: {
						schemaVersion: 1,
						installations: { "acme.tools": installation },
					},
				}),
			).success,
		).toBe(false);
	});

	test("rejects a noncanonical Agent Plugin installation key", () => {
		expect(
			hostedRuntimeBundleV2ManifestSchema.safeParse(
				hostedManifestFixture({
					agentPlugins: {
						schemaVersion: 1,
						installations: { Acme: TEST_AGENT_PLUGIN_INSTALLATION },
					},
				}),
			).success,
		).toBe(false);
	});

	test("fails closed before converging unsupported Agent Plugins installations", () => {
		const paths = tempRuntimePaths();
		const hosted = hostedRuntimeBundleV2ManifestSchema.parse(
			hostedManifestFixture({ agentPlugins: TEST_AGENT_PLUGINS }),
		);
		const normalized = hostedManifestToRuntimeManifest(hosted);

		expect(() =>
			convergeRuntimeManifestWithContract(
				manifestLoad(normalized, "inline-hosted-agent-plugins"),
				paths,
			),
		).toThrow(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);

		const desired = preparedTestAgentPlugin("acme.tools", "1.2.3", "a".repeat(64));
		const nonHosted: RuntimeManifest = {
			...normalized,
			projection: { agentPlugins: testAgentPluginDesiredState(desired) },
		};
		expect(() =>
			convergeRuntimeManifestWithContract(
				manifestLoad(nonHosted, "inline-generic-agent-plugins"),
				paths,
				{
					preparedHostedAgentPlugins: preparedTestAgentPluginState(desired),
				},
			),
		).toThrow(AGENT_PLUGIN_HOSTED_V2_REQUIRED_ERROR);
	});

	test("fails closed when native Agent Plugin lifecycle support is unavailable", () => {
		const paths = tempRuntimePaths();
		const desired = preparedTestAgentPlugin("acme.tools", "1.2.3", "a".repeat(64));
		const prepared = preparedTestAgentPluginState(desired);
		const unavailableRunner: HostedAgentPluginCommandRunner = {
			available: () => false,
			run: () => {
				throw new Error("unsupported runtime must not execute Agent Plugin commands");
			},
		};
		const commands = hostedAgentPluginCommands(paths.userHome);
		expect(() =>
			planHostedAgentPluginConvergence({
				prepared,
				home: paths.userHome,
				commands,
				runner: unavailableRunner,
			}),
		).toThrow("Agent Plugin capability probe runtime command is unavailable");
	});

	test("orders cold native plugin activation and restores the full preimage after failure", () => {
		const paths = tempRuntimePaths();
		const eventLog = join(dirname(paths.userHome), "agent-plugin-order.log");
		const installerPath = join(dirname(paths.userHome), "openclaw-agent-plugin-installer.sh");
		const commandPath = join(paths.userHome, ".local", "bin", "openclaw");
		const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
		writeFileSync(
			installerPath,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' binary-install >> '${eventLog}'
mkdir -p '${dirname(commandPath)}'
cat > '${commandPath}' <<'CLI'
#!/usr/bin/env bash
set -euo pipefail
plugin_root=""
for plugin_file in "$HOME"/.openclaw/extensions/*/plugin.json; do
  [[ -f "$plugin_file" ]] || continue
  plugin_root="\${plugin_file%/plugin.json}"
  break
done
plugin_native_id="\${plugin_root##*/}"
plugin_name=""
if [[ -n "$plugin_root" ]]; then
  plugin_name=$(sed -n 's/.*"name":"\\([^"]*\\)".*/\\1/p' "$plugin_root/plugin.json")
fi
plugin_config="$HOME/.openclaw/openclaw.json"
plugin_database="$HOME/.openclaw/state/openclaw.sqlite"
plugin_enabled=false
if [[ -f "$plugin_config" ]] && grep -q '"enabled":true' "$plugin_config"; then
  plugin_enabled=true
fi
plugin_status=disabled
if [[ "$plugin_enabled" == true ]]; then plugin_status=loaded; fi

case "\${1:-}" in
  --version)
    printf '%s\\n' 'OpenClaw test-version'
    ;;
  agents)
    [[ "\${2:-}" == list && "\${3:-}" == --json ]] || exit 2
    printf '[{"id":"main","workspace":"%s"}]\\n' "$HOME/.openclaw/workspace"
    ;;
  config)
    [[ "\${2:-}" == patch && "\${3:-}" == --stdin ]] || exit 2
    cat >/dev/null
    printf '%s\\n' '{"ok":true}'
    ;;
  gateway)
    [[ "\${2:-}" == install && "\${3:-}" == --force && "\${4:-}" == --json ]] || exit 2
    printf '%s\\n' gateway-install >> '${eventLog}'
    mkdir -p '${dirname(unitPath)}'
    printf '%s\\n' '[Unit]' '[Service]' 'ExecStart=openclaw gateway run' > '${unitPath}'
    printf '%s\\n' '{"ok":true}'
    ;;
  plugins)
    case "\${2:-}" in
      list)
        [[ "\${3:-}" == --json ]] || exit 2
	        if [[ -z "$plugin_root" || ! -f "$plugin_root/plugin.json" ]]; then
          printf '%s\\n' '{"plugins":[]}'
          exit 0
        fi
        version=$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$plugin_root/plugin.json")
	        printf '{"plugins":[{"id":"%s","name":"%s","version":"%s","enabled":%s,"status":"%s","format":"bundle","bundleFormat":"agent"}]}\\n' "$plugin_native_id" "$plugin_name" "$version" "$plugin_enabled" "$plugin_status"
        ;;
      inspect)
	        [[ "\${3:-}" == "$plugin_native_id" && "\${4:-}" == --json && -f "$plugin_root/plugin.json" ]] || exit 2
        version=$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$plugin_root/plugin.json")
	        printf '{"plugin":{"id":"%s","name":"%s","source":"test","origin":"config","status":"%s","version":"%s","enabled":%s,"format":"bundle","bundleFormat":"agent"},"mcpServers":[],"diagnostics":[],"install":{"source":"path","installPath":"%s","resolvedVersion":"%s"}}\\n' "$plugin_native_id" "$plugin_name" "$plugin_status" "$version" "$plugin_enabled" "$plugin_root" "$version"
        ;;
	      install)
	        [[ "\${4:-}" == --force && -f "\${3:-}/plugin.json" ]] || exit 2
	        plugin_name=$(sed -n 's/.*"name":"\\([^"]*\\)".*/\\1/p' "$3/plugin.json")
	        plugin_native_id="\${plugin_name//./-}"
	        plugin_root="$HOME/.openclaw/extensions/$plugin_native_id"
	        version=$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$3/plugin.json")
	        if [[ "$HOME" == '${paths.userHome}' ]]; then
	          printf 'plugin-apply:%s\\n' "$version" >> '${eventLog}'
        else
          printf 'probe-install:%s\\n' "$version" >> '${eventLog}'
        fi
        rm -rf "$plugin_root"
        mkdir -p "$(dirname "$plugin_root")"
        cp -R "$3" "$plugin_root"
        mkdir -p "$(dirname "$plugin_config")"
	        printf '{"plugins":{"entries":{"%s":{"enabled":false}}}}\\n' "$plugin_native_id" > "$plugin_config"
        mkdir -p "$(dirname "$plugin_database")"
        printf 'installed:%s\\n' "$version" > "$plugin_database"
        printf 'wal:%s\\n' "$version" > "$plugin_database-wal"
        printf 'shm:%s\\n' "$version" > "$plugin_database-shm"
        ;;
	      enable|disable)
	        [[ "\${3:-}" == "$plugin_native_id" && -f "$plugin_root/plugin.json" ]] || exit 2
	        enabled=false
	        if [[ "$2" == enable ]]; then enabled=true; fi
	        printf '{"plugins":{"entries":{"%s":{"enabled":%s}}}}\\n' "$plugin_native_id" "$enabled" > "$plugin_config"
	        version=$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$plugin_root/plugin.json")
	        if [[ "$HOME" == '${paths.userHome}' && "$2" == enable && "$version" == 2.0.0 ]]; then
	          printf '%s\\n' enable-failed > "$plugin_database"
	          printf '%s\\n' enable-failed > "$plugin_database-wal"
	          printf '%s\\n' enable-failed > "$plugin_database-shm"
	          printf '%s\\n' native-enable-failure >> '${eventLog}'
	          exit 8
	        fi
	        ;;
      uninstall)
	        [[ "\${3:-}" == "$plugin_native_id" && "\${4:-}" == --force ]] || exit 2
        rm -rf "$plugin_root"
        printf '%s\\n' '{}' > "$plugin_config"
        printf '%s\\n' uninstalled > "$plugin_database"
        rm -f "$plugin_database-wal"
        printf '%s\\n' dirty > "$plugin_database-shm"
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
CLI
chmod 0755 '${commandPath}'
`,
		);
		chmodSync(installerPath, 0o700);
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = installerPath;
		const previous = preparedTestAgentPlugin("acme.tools", "1.0.0", "a".repeat(64));
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
						args: officialInstallArgs("openclaw", paths.userHome),
					},
					run: runSettings(commandPath, ["gateway", "run"]),
					services: {},
				},
			},
			{
				runtime: "openclaw",
				openclawGatewayAuth: hostedOpenClawNativeAuth(),
				projection: {
					sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
					agentPlugins: testAgentPluginDesiredState(previous),
				},
			},
		);
		let firstRestartUnits: string[] = [];
		let firstQuiescedUnits: readonly string[] = [];
		const first = convergeRuntimeManifest(manifestLoad(manifest, "agent-plugin-cold-boot"), paths, {
			cacheLastGood: false,
			preparedHostedAgentPlugins: preparedTestAgentPluginState(previous),
			commitAuthority: () => undefined,
			systemdApply: {
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: (signal) => {
					firstRestartUnits = signal.restartUserUnits;
					writeFileSync(eventLog, "activation\n", { flag: "a" });
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
				quiesce: (affectedUserUnits) => {
					firstQuiescedUnits = affectedUserUnits;
					writeFileSync(eventLog, "quiesce\n", { flag: "a" });
				},
				rollback: () => {
					throw new Error("successful cold boot must not roll back");
				},
			},
		});
		expect(first.installErrors).toEqual([]);
		expect(readFileSync(eventLog, "utf8").trim().split("\n")).toEqual([
			"binary-install",
			"probe-install:1.0.0",
			"probe-install:1.0.0",
			"quiesce",
			"plugin-apply:1.0.0",
			"gateway-install",
			"activation",
		]);
		expect(firstQuiescedUnits).toEqual(["openclaw-gateway.service"]);
		expect(firstRestartUnits).toEqual(["openclaw-gateway.service"]);
		expect(
			planRuntimeMutationSystemdUserUnits({
				runtimePrograms: [
					{
						programKind: "runtime",
						runtime: "hermes",
						service: null,
						command: join(paths.userHome, ".local", "bin", "hermes"),
						args: ["gateway"],
						cwd: paths.userHome,
						env: {},
						resolvedSecretEnv: {},
					},
				],
				staleUserUnits: ["openclaw-gateway.service", "clawdi-files.service"],
				mutationRuntimes: new Set(["openclaw", "hermes"]),
			}),
		).toEqual({
			quiesceUserUnits: ["hermes-gateway.service", "openclaw-gateway.service"],
			restartUserUnits: ["hermes-gateway.service"],
		});

		const pluginRoot = join(paths.userHome, ".openclaw", "extensions", "acme-tools");
		const configPath = join(paths.userHome, ".openclaw", "openclaw.json");
		const receiptPath = hostedAgentPluginReceiptsPath(paths);
		const pluginManifestPath = join(pluginRoot, "plugin.json");
		const pluginDatabasePath = join(paths.userHome, ".openclaw", "state", "openclaw.sqlite");
		const preimage = new Map(
			[
				pluginManifestPath,
				configPath,
				receiptPath,
				pluginDatabasePath,
				`${pluginDatabasePath}-wal`,
				`${pluginDatabasePath}-shm`,
			].map((path) => [path, readFileSync(path)]),
		);
		const desired = preparedTestAgentPlugin("acme.tools", "2.0.0", "b".repeat(64));
		const nextManifest: RuntimeManifest = {
			...manifest,
			generation: 2,
			issuedAt: "2026-07-01T00:02:00.000Z",
			projection: {
				sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
				agentPlugins: testAgentPluginDesiredState(desired),
			},
		};
		let isolatedAuthorityCommits = 0;
		let isolatedActivations = 0;
		const isolated = convergeRuntimeManifest(
			manifestLoad(nextManifest, "agent-plugin-isolated-failure"),
			paths,
			{
				cacheLastGood: false,
				preparedHostedAgentPlugins: preparedTestAgentPluginState(desired, previous),
				commitAuthority: () => isolatedAuthorityCommits++,
				systemdApply: {
					activateEgressPrerequisite: successfulPrerequisiteActivation,
					activate: () => {
						isolatedActivations += 1;
						return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
					},
					quiesce: () => undefined,
					rollback: () => {
						throw new Error("isolated Agent Plugin failure must not roll back core");
					},
				},
			},
		);
		expect(isolated.installErrors).toEqual([]);
		expect(isolated.resourceProjectionErrors.join("\n")).toContain(
			"OpenClaw native Agent Plugin state change failed",
		);
		expect(isolated.agentPluginFailedNames).toEqual(["acme.tools"]);
		expect(isolatedAuthorityCommits).toBe(1);
		expect(isolatedActivations).toBe(1);
		for (const [path, content] of preimage) expect(readFileSync(path)).toEqual(content);
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
						apiMode: "openai_responses",
						managed_by: "clawdi",
						runtimeEnvName: "CLAWDI_AI_API_KEY",
						models: [
							{
								id: "k3",
								context_window: 1_048_576,
								max_input_tokens: 1_048_576,
								input_modalities: ["text", "image"],
								supports_tools: true,
								supports_reasoning: true,
								compat: { supportsDeveloperRole: false },
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
					compat: { supportsDeveloperRole: false },
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

	test("rejects the terminal Codex env name for managed runtime providers", () => {
		const provider = {
			...TEST_HOSTED_CODEX_TOOLING.codex.provider,
			runtimeEnvName: "OPENAI_API_KEY",
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

	test("rejects retired terminal Codex provider shapes", () => {
		const legacyEnv = structuredClone(TEST_HOSTED_CODEX_TOOLING);
		legacyEnv.codex.provider.runtimeEnvName = "OPENAI_API_KEY";
		expect(
			hostedRuntimeManifestSchema.safeParse(hostedManifestFixture({ terminalTooling: legacyEnv }))
				.success,
		).toBe(false);

		const legacyCatalog: unknown = {
			...structuredClone(TEST_HOSTED_CODEX_TOOLING),
			codex: {
				...structuredClone(TEST_HOSTED_CODEX_TOOLING.codex),
				provider: {
					...structuredClone(TEST_HOSTED_CODEX_TOOLING.codex.provider),
					models: [{ id: "legacy-codex-model" }],
				},
			},
		};
		expect(
			hostedRuntimeManifestSchema.safeParse(
				hostedManifestFixture({ terminalTooling: legacyCatalog }),
			).success,
		).toBe(false);
	});

	test.each(["openai_chat", "anthropic_messages", "google_generate_content"])(
		"rejects terminal Codex without the fixed responses API mode (%s)",
		(apiMode) => {
			const terminalTooling = structuredClone(TEST_HOSTED_CODEX_TOOLING);
			terminalTooling.codex.provider.apiMode = apiMode;
			const manifest = hostedManifestFixture({ terminalTooling });
			expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(false);
		},
	);

	test("rejects terminal Codex without an API mode", () => {
		const { apiMode: _apiMode, ...provider } = TEST_HOSTED_CODEX_TOOLING.codex.provider;
		const terminalTooling = {
			codex: { ...TEST_HOSTED_CODEX_TOOLING.codex, provider },
		};
		const manifest = hostedManifestFixture({ terminalTooling });
		expect(hostedRuntimeManifestSchema.safeParse(manifest).success).toBe(false);
	});

	test.each(["secret://provider.stale.apiKey", "secret://provider.other.apiKey"])(
		"rejects provider secret value %s in unmanaged mode",
		(secretRef) => {
			const runtime = hostedRuntimeFixture({
				providerMode: "unmanaged",
				provider_ids: [],
			});
			delete runtime.primary_model;
			const manifest = hostedManifestFixture({
				providers: {},
				runtimes: { openclaw: runtime },
			});
			expect(() => normalizeHostedBundleFixture(manifest, { [secretRef]: "secret" })).toThrow(
				"unmanaged provider mode must not include provider secret values",
			);
		},
	);

	test("accepts either Codex tool secret-ref alias in unmanaged mode", () => {
		const runtime = hostedRuntimeFixture({ providerMode: "unmanaged", provider_ids: [] });
		delete runtime.primary_model;
		const manifest = hostedManifestFixture({ providers: {}, runtimes: { openclaw: runtime } });
		const codexRef = TEST_HOSTED_CODEX_TOOLING.codex.provider.apiKeySecretRef;
		expect(codexRef).toBeDefined();
		for (const secretRef of [codexRef, `secret://${codexRef}`]) {
			expect(() => normalizeHostedBundleFixture(manifest, { [secretRef]: "secret" })).not.toThrow();
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
		expect("version" in (parsed.runtimes.custom.install ?? {})).toBe(false);
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
		const openclawBin = join(paths.userHome, ".local", "bin", "openclaw");
		const patchPath = join(paths.serviceStateRoot, "openclaw-gateway-patch.json");
		const allowedOrigins = ["https://app-v2-18789.k3s.example.test"];
		process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeFileSync(
			openclawBin,
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then',
				`  printf '%s\\n' 'OpenClaw test-version'`,
				"  exit 0",
				"fi",
				'if [ "$1 $2 $3" = "agents list --json" ]; then',
				'  printf \'[{"id":"main","workspace":"%s"}]\\n\' "$HOME/.openclaw/workspace"',
				"  exit 0",
				"fi",
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
				auth: { mode: "token", token: "gateway-token" },
				controlUi: {
					allowedOrigins,
					dangerouslyAllowHostHeaderOriginFallback: false,
				},
			},
		});
	});

	test("projects hosted OpenClaw v2 direct token auth", () => {
		const paths = tempRuntimePaths();
		const openclawBin = join(paths.userHome, ".local", "bin", "openclaw");
		const patchPath = join(paths.serviceStateRoot, "openclaw-native-auth-patch.json");
		const openclawPackageRoot = join(
			paths.userHome,
			".local",
			"tools",
			"node",
			"lib",
			"node_modules",
			"openclaw",
		);
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(openclawPackageRoot, { recursive: true });
		writeFileSync(
			join(openclawPackageRoot, "device-bootstrap.mjs"),
			"export const normalizeDeviceBootstrapProfile = (profile) => profile;\n",
		);
		writeFileSync(
			join(openclawPackageRoot, "package.json"),
			JSON.stringify({
				name: "openclaw",
				type: "module",
				exports: { "./plugin-sdk/device-bootstrap": "./device-bootstrap.mjs" },
			}),
		);
		writeFileSync(
			openclawBin,
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then',
				`  printf '%s\\n' 'OpenClaw test-version'`,
				"  exit 0",
				"fi",
				'if [ "$1 $2 $3" = "agents list --json" ]; then',
				'  printf \'[{"id":"main","workspace":"%s"}]\\n\' "$HOME/.openclaw/workspace"',
				"  exit 0",
				"fi",
				'if [ "$1 $2 $3" = "config patch --stdin" ]; then',
				`  cat > '${patchPath}'`,
				"  exit 0",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		chmodSync(openclawBin, 0o700);

		const legacy = hostedOpenClawV2ManifestFixture({}, LEGACY_HOSTED_OPENCLAW_GATEWAY_RUN_ARGS);
		const hosted = hostedRuntimeBundleV2ManifestSchema.parse(legacy);
		const projected = hostedManifestToRuntimeManifest(hosted);
		expect(projected.runtimes.openclaw.run?.args).toEqual(["gateway", "run"]);
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
					token: "gateway-token",
				},
				controlUi: {
					basePath: "/control",
					allowedOrigins: ["https://agent.example.test"],
					dangerouslyAllowHostHeaderOriginFallback: false,
					dangerouslyDisableDeviceAuth: null,
				},
			},
		});
		expect(JSON.stringify(gatewayPatch)).toContain("gateway-token");
		const gatewayEnv = readFileSync(
			join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
			"utf8",
		);
		expect(gatewayEnv).not.toContain("OPENCLAW_GATEWAY_TOKEN");
		expect(gatewayEnv).not.toContain("gateway-token");
		const gatewayDropIn = readFileSync(
			join(paths.systemdUserRoot, "openclaw-gateway.service.d", "10-clawdi-hosted.conf"),
			"utf8",
		);
		expect(gatewayDropIn).not.toContain("\nExecStart=");
		expect(gatewayDropIn).not.toContain("\nWorkingDirectory=");
		expect(result.outputs.systemdSystemUnits.map((path) => path.split("/").at(-1))).toContain(
			"clawdi-runtime-sidecar.service",
		);
	});

	test("rejects hosted manifests without an explicit CLI package policy", () => {
		expect(() =>
			hostedRuntimeManifestSchema.parse({
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
				runtime: "openclaw",
				deploymentId: "hdep_missing_cli_policy",
				environmentId: "env_missing_cli_policy",
				instanceId: "hri_missing_cli_policy",
				generation: 1,
				issuedAt: "2026-07-11T00:00:00.000Z",
				locale: TEST_HOSTED_LOCALE,
				controlPlane: { cloudApiUrl: "https://cloud-api.example.test" },
				runtimes: { openclaw: { enabled: true } },
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
				packageSpec: "clawdi@1.2.3-test",
				registry: "https://registry.npmjs.org",
			},
		},
		{
			name: "missing registry",
			clawdiCli: { source: "npm:clawdi", packageSpec: "clawdi@1.2.3-test" },
		},
		{
			name: "non-official registry",
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@1.2.3-test",
				registry: "https://registry.example.test",
			},
		},
		{
			name: "dead managed flags",
			clawdiCli: {
				source: "npm:clawdi",
				packageSpec: "clawdi@1.2.3-test",
				registry: "https://registry.npmjs.org",
				managedConfig: true,
				userEditableConfig: false,
			},
		},
	])("rejects hosted CLI policy with $name", ({ clawdiCli }) => {
		expect(() =>
			hostedRuntimeManifestSchema.parse({
				schemaVersion: "clawdi.hosted-runtime.manifest.v1",
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
			}),
		).toThrow();
	});

	test.each(["clawdi@1.2.3-test", "clawdi@1.2.3-rc-1.2", "clawdi@1.2.3"])(
		"accepts exact hosted CLI package spec %s",
		(packageSpec) => {
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
		},
	);

	test("enforces the Cloud package spec length limit", () => {
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
		}
	});

	test("rejects raw secretValues keys in the Hosted fixture contract", () => {
		expect(
			z.record(canonicalSecretRefSchema, z.string()).safeParse({
				"tool.codex.apiKey": "must-be-rejected",
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
		"/usr/local/share/clawdi/bootstrap/clawdi-1.2.3-test.tgz",
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
					packageSpec: "clawdi@1.2.3-test",
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
							args: ["gateway", "run"],
							secretEnv: {
								OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
							},
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

		const hostedManifest = hostedRuntimeManifestSchema.parse(hostedResponse.manifest);
		const normalized = {
			manifest: hostedManifestToRuntimeManifest(hostedManifest),
			secretValues: normalizeSecretValues(hostedResponse.secretValues),
		};
		expect(normalized.manifest.schemaVersion).toBe("clawdi.runtimeDesiredState.v1");
		expect(normalized.manifest.runtime).toBe("openclaw");
		expect(Object.keys(normalized.manifest.runtimes)).toEqual(["openclaw"]);
		expect(normalized.manifest.runtimes.openclaw.enabled).toBe(true);
		expect(normalized.manifest.runtimes.openclaw.updateChannel).toBeUndefined();
		const install = normalized.manifest.runtimes.openclaw.install;
		expect(install?.url).toBe(OFFICIAL_INSTALL_URLS.openclaw);
		expect(install?.args).toEqual(officialInstallArgs("openclaw", install?.home ?? ""));
		expect(install?.args).not.toContain("--version");
		expect(normalized.manifest.runtimes.openclaw.run?.args).toEqual(["gateway", "run"]);
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
					packageSpec: "clawdi@1.2.3-test",
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
				packageSpec: "clawdi@1.2.3-test",
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
					packageSpec: "clawdi@1.2.3-test",
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
						run: {
							args: ["gateway", "run"],
							secretEnv: {
								OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
							},
						},
						services: {},
					},
					hermes: {
						enabled: true,
						install: { source: "official" },
						providerMode: "configured",
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-test" },
						run: { args: ["gateway", "run"] },
						services: {
							dashboard: {
								args: ["dashboard", "--host", "0.0.0.0", "--port", "9119", "--no-open"],
							},
						},
					},
				},
			}),
		).toThrow("hosted runtime manifests must declare exactly one selected runtime");
	});

	test("converges OpenClaw native token auth from canonical bundle secret refs", () => {
		const paths = tempRuntimePaths();
		writeFakeGatewayCli({
			path: join(paths.userHome, ".local", "bin", "openclaw"),
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
		});
		const manifest = baseManifest(
			paths,
			{
				openclaw: {
					enabled: true,
					run: {
						command: "openclaw",
						args: ["gateway", "run"],
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
		expect(runConfig.defaultArgs).toEqual(["gateway", "run"]);
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
		expect(unit).not.toContain("\nExecStart=");
		expect(unit).not.toContain("\nWorkingDirectory=");
		const envFile = readFileSync(
			join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
			"utf8",
		);
		expect(envFile).toContain('OPENCLAW_GATEWAY_TOKEN="gateway-token"');
	});

	test("keeps hosted managed provider key out of the agent env", () => {
		const paths = tempRuntimePaths();
		const configPath = writeFakeOpenClawConfigMutationSdk(paths.userHome);
		writeFakeGatewayCli({
			path: join(paths.userHome, ".local", "bin", "openclaw"),
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
		});
		const hosted = hostedRuntimeManifestSchema.parse(
			hostedManifestFixture({
				providers: {
					default: {
						kind: "openai-compatible",
						type: "custom_openai_compatible",
						managed_by: "clawdi",
						baseUrl: "https://api.example.test/v1",
						models: [{ id: "gpt-test" }],
						apiMode: "openai_responses",
						runtimeEnvName: "CLAWDI_AI_API_KEY",
						apiKeySecretRef: "secret://providers/default/api-key",
					},
				},
			}),
		);
		const manifest = {
			...hostedManifestToRuntimeManifest(hosted),
			egressEngine: installCachedTestEgressEngine(paths, "12.2.3-test-provider-model"),
		};
		const provider = hostedAiProviderCatalog(manifest, "openclaw")?.catalog.providers[0];
		expect(provider?.runtime_env_name).toBe("CLAWDI_AI_API_KEY");

		const result = convergeRuntimeManifest(
			manifestLoad(manifest, "inline-managed-provider", {
				...TEST_HOSTED_SECRET_VALUES,
				"secret://providers/default/api-key": "sk-managed",
			}),
			paths,
		);

		expect(result.installErrors).toEqual([]);
		expect(result.projectedProviderIds.openclaw).toEqual(["clawdi-managed"]);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
			models: {
				providers: {
					"clawdi-managed": {
						apiKey: {
							source: "env",
							provider: "default",
							id: "CLAWDI_AI_API_KEY",
						},
					},
				},
			},
		});
		const runConfig = JSON.parse(readFileSync(runtimeRunConfigPath("openclaw", paths), "utf8")) as {
			env?: Record<string, string>;
		};
		expect(runConfig.env?.CLAWDI_AI_API_KEY).toBe("clawdi-egress-placeholder");
		expect(runConfig.env?.OPENAI_API_KEY).toBeUndefined();
		const envFile = readFileSync(
			join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
			"utf8",
		);
		expect(envFile).toContain('CLAWDI_AI_API_KEY="clawdi-egress-placeholder"');
		expect(envFile).not.toMatch(/^OPENAI_API_KEY=/m);
		expect(envFile).not.toContain("sk-managed");
	});

	test("replaces the selected Hermes provider with secret refs and stale cleanup", () => {
		const paths = tempRuntimePaths();
		process.env.HERMES_TEST_PROVIDER_TOKEN = "resolved-provider-secret-must-not-be-written";
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
		mkdirSync(dirname(legacyPlugin), { recursive: true });
		writeFakeGatewayCli({
			path: hermesCommand,
			runtime: "hermes",
			unitPath: join(paths.systemdUserRoot, "hermes-gateway.service"),
		});
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
				'  "user.custom":',
				"    api: https://user-provider.example.test/v1",
				`    api_key: "${HERMES_TEST_PROVIDER_TOKEN_REF}"`,
				"",
			].join("\n"),
		);
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
		expect(readFileSync(legacyPlugin, "utf8")).toBe('raise RuntimeError("obsolete")\n');
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
		expect(initialHermes.providers?.["user.custom"]).toMatchObject({
			api: "https://user-provider.example.test/v1",
			api_key: HERMES_TEST_PROVIDER_TOKEN_REF,
		});
		expect(JSON.parse(initialRunConfig)).toMatchObject({
			secretEnv: {
				RESPONSES_API_KEY: "secret://providers/responses/api-key",
			},
		});
		expect(initialConfig).not.toContain(responsesKey);
		expect(initialConfig).not.toContain("resolved-provider-secret-must-not-be-written");
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
		expect(switchedProviders?.["user.custom"]).toMatchObject({
			api_key: HERMES_TEST_PROVIDER_TOKEN_REF,
		});
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
		expect(deletedProviders?.["user.custom"]).toMatchObject({
			api_key: HERMES_TEST_PROVIDER_TOKEN_REF,
		});
	}, 30_000);

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
									compat: { supportsDeveloperRole: false },
								},
								{ id: "kimi-for-coding" },
								{ id: "kimi-for-coding-highspeed", context_window: 262_144 },
							],
							apiMode: "openai_responses",
							runtimeEnvName: "CLAWDI_AI_API_KEY",
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
				compat: { supportsDeveloperRole: false },
			},
			{ id: "kimi-for-coding" },
			{ id: "kimi-for-coding-highspeed", context_window: 262_144 },
		]);
	});

	test.each(["openclaw", "default"])(
		"does not infer strict hosted provider bindings from the %s provider key",
		(providerKey) => {
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
		},
	);

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
				quiesce: () => {},
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

	test("publishes transparent egress env as a root-authored read-only handoff to the numeric egress identity", () => {
		const numericPrivilegeToolPath = ["/usr/bin/set", "priv"].join("");
		if (process.geteuid?.() !== 0 || !existsSync(numericPrivilegeToolPath)) return;
		const paths = tempRuntimePaths();
		const egressUid = 10_002;
		const egressGid = 10_002;
		process.env.CLAWDI_EGRESS_UID = String(egressUid);
		process.env.CLAWDI_EGRESS_GID = String(egressGid);
		process.env.CLAWDI_RUNTIME_USER = "clawdi";
		process.env.CLAWDI_RUNTIME_UID = "10001";
		process.env.CLAWDI_RUNTIME_GID = "10001";
		const manifest = egressRuntimeManifest(paths, {
			generation: 1,
			engine: installCachedTestEgressEngine(paths, "12.2.3-test-egress-env-identity"),
			profile: "enabled",
		});
		chmodSync(dirname(paths.serviceStateRoot), 0o777);
		const result = convergeRuntimeManifest(
			manifestLoad(manifest, "root-egress-env-handoff"),
			paths,
			{
				cacheLastGood: false,
				systemdApply: {
					quiesce: () => {},
					activateEgressPrerequisite: successfulPrerequisiteActivation,
					activate: successfulPrerequisiteActivation,
					rollback: () => {},
				},
				hostedRuntimeContract: {
					expectedIdentity: {
						home: paths.userHome,
						user: "clawdi",
						uid: 10_001,
						gid: 10_001,
					},
					resolveUserIdentity: () => ({ uid: 10_001, gid: 10_001 }),
				},
			},
		);
		expect(result.installErrors).toEqual([]);

		const envFile = paths.egressTransparentEnv;
		const node = statSync(envFile);
		expect([node.uid, node.gid]).toEqual([0, egressGid]);
		expect(node.mode & 0o777).toBe(0o640);
		expect(statSync(paths.egressRoot).mode & 0o777).toBe(0o711);
		expect(statSync(paths.egressTransparentEnv).mode & 0o022).toBe(0);

		const runAsEgressIdentity = (args: string[]) =>
			execFileSync(
				numericPrivilegeToolPath,
				[`--reuid=${egressUid}`, `--regid=${egressGid}`, "--clear-groups", "--", ...args],
				{ encoding: "utf8" },
			);
		expect(runAsEgressIdentity(["sh", "-c", `cat -- ${JSON.stringify(envFile)}`])).toContain(
			`CLAWDI_EGRESS_GID="${egressGid}"`,
		);
		expect(() => runAsEgressIdentity(["sh", "-c", `: > ${JSON.stringify(envFile)}`])).toThrow();
	});

	test("restarts only active sidecars for committed egress secret lifecycle changes", () => {
		const paths = tempRuntimePaths();
		const commandPath = join(paths.userHome, ".local", "bin", "openclaw");
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
		writeFakeGatewayCli({
			path: commandPath,
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
		});
		mkdirSync(dirname(engineBinary), { recursive: true });
		writeFileSync(engineBinary, "#!/usr/bin/env sh\nexit 0\n");
		chmodSync(engineBinary, 0o700);
		const secretRef = "secret://runtime/egress/test-token";
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
							id: "managed-api",
							enabled: true,
							kind: "http",
							match: {
								scheme: "https",
								host: "api.example.test:443",
								path: { type: "equals", value: "/v1/data" },
								headers: {
									"X-Route-Key": {
										type: "equals",
										value: "managed",
									},
								},
								query: {},
							},
							rewrite: {
								upstreamBaseUrl: "http://localhost:9000",
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
							priority: 60,
							owner: "runtime:test",
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
						quiesce: () => {},
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
		expect(readFileSync(gatewayEnv, "utf-8")).not.toContain("000000");

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
		const commandPath = join(paths.userHome, ".local", "bin", "openclaw");
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
		writeFakeGatewayCli({
			path: commandPath,
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
		});
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
				quiesce: () => {},
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
				quiesce: () => {},
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
				quiesce: () => {},
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
				quiesce: () => {},
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
				quiesce: () => {},
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
				quiesce: () => {},
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
				quiesce: () => {},
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
				quiesce: () => {},
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
				quiesce: () => {},
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
					quiesce: () => {},
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
				quiesce: () => {},
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
		const openclawCommand = join(paths.userHome, ".local", "bin", "openclaw");
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
		const openClawWorkspaceRoot = join(paths.userHome, ".openclaw", "workspace");
		const soulPath = join(openClawWorkspaceRoot, "SOUL.md");
		const staleRunConfig = join(paths.runConfigRoot, "stale-runtime.json");
		const systemdUnit = join(paths.systemdUserRoot, "clawdi-openclaw.service");
		const installerPath = join(dirname(paths.userHome), "openclaw-installer.sh");
		const installerLog = join(dirname(paths.userHome), "openclaw-installer.log");
		writeFileSync(
			installerPath,
			`#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/openclaw" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"%s"}]\\n' "$HOME/.openclaw/workspace"
  exit 0
fi
exit 64
EOF
chmod 0700 "$HOME/.local/bin/openclaw"
echo spawned > '${installerLog}'
`,
		);
		chmodSync(installerPath, 0o700);
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = installerPath;
		mkdirSync(openClawWorkspaceRoot, { recursive: true });
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
						args: officialInstallArgs("openclaw", paths.userHome),
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
		expect(readFileSync(installerLog, "utf8")).toBe("spawned\n");
		expect(existsSync(join(paths.userHome, ".local", "bin", "openclaw"))).toBe(false);
	});

	test("reconciles 0.13.92 Skill trees from ledger-backed ownership", () => {
		const paths = tempRuntimePaths();
		ensureRuntimeStateDirs(paths);
		const runningAsRoot = process.geteuid?.() === 0;
		const runtimeUser = runningAsRoot ? "nobody" : TEST_RUNTIME_USER;
		const runtimeUid = runningAsRoot
			? Number.parseInt(execFileSync("id", ["-u", runtimeUser], { encoding: "utf8" }).trim(), 10)
			: TEST_PROCESS_UID;
		const runtimeGid = runningAsRoot
			? Number.parseInt(execFileSync("id", ["-g", runtimeUser], { encoding: "utf8" }).trim(), 10)
			: TEST_PROCESS_GID;
		process.env.CLAWDI_RUNTIME_USER = runtimeUser;
		process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
		process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		const openClawCommand = join(paths.userHome, ".local", "bin", "openclaw");
		mkdirSync(dirname(hermesCommand), { recursive: true });
		writeFileSync(hermesCommand, "#!/bin/sh\nexit 0\n");
		chmodSync(hermesCommand, 0o755);
		writeFakeGatewayCli({
			path: openClawCommand,
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
		});
		if (runningAsRoot) {
			chmodSync(dirname(paths.serviceStateRoot), 0o755);
			for (const path of [
				paths.userHome,
				join(paths.userHome, ".local"),
				dirname(hermesCommand),
				hermesCommand,
				openClawCommand,
			]) {
				chownSync(path, runtimeUid, runtimeGid);
			}
		}
		const skillsRoot = join(paths.userHome, ".hermes", "skills");
		const enabledTarget = join(skillsRoot, "clawdi");
		const enabledSourcedId = "review-pr";
		const disabledId = "disabled-review-pr";
		const disabledTarget = join(skillsRoot, disabledId);
		const legacyReceiptDirectory = join(skillsRoot, ".clawdi-manifest-receipts");
		const openClawSkillsRoot = join(paths.userHome, ".openclaw", "workspace", "skills");
		const openClawEnabledSourcedTarget = join(openClawSkillsRoot, enabledSourcedId);
		const openClawLegacyReceiptDirectory = join(openClawSkillsRoot, ".clawdi-manifest-receipts");
		const platformReceiptDirectory = join(paths.managedResourceRoot, "skill-receipts");
		const bundledSource = resolve(
			import.meta.dir,
			"../..",
			"skills",
			"hosted-versions",
			"1",
			"clawdi",
		);
		const catalogEntry = resolveHostedBundledSkill("clawdi", 1);
		const enabledSourcedSource = {
			type: "github" as const,
			url: "https://github.com/Clawdi-AI/store",
			path: `skills/${enabledSourcedId}`,
			commit: "b".repeat(40),
		};
		const enabledSourced = preparedTestSourcedSkill(
			enabledSourcedId,
			enabledSourcedSource,
			"# Current Review PR\n",
		);
		const disabledSource = {
			type: "github" as const,
			url: "https://github.com/Clawdi-AI/store",
			path: `skills/${disabledId}`,
			commit: "a".repeat(40),
		};
		const disabledSourceIdentity = [
			"github",
			disabledId,
			disabledSource.url,
			disabledSource.path,
			disabledSource.commit,
		].join("\0");
		cpSync(bundledSource, enabledTarget, { recursive: true });
		writeFileSync(
			join(enabledTarget, ".clawdi-managed.json"),
			`${JSON.stringify({
				schema: "clawdi.hostedBundledSkillMarker.v1",
				owner: "clawdi runtime init",
				id: "clawdi",
				version: 1,
				digest: catalogEntry.digest,
			})}\n`,
		);
		mkdirSync(disabledTarget, { recursive: true });
		writeFileSync(join(disabledTarget, "SKILL.md"), "# Review PR\n");
		mkdirSync(openClawEnabledSourcedTarget, { recursive: true });
		writeFileSync(join(openClawEnabledSourcedTarget, "SKILL.md"), "# Legacy Review PR\n");
		mkdirSync(legacyReceiptDirectory, { recursive: true });
		writeFileSync(
			join(legacyReceiptDirectory, `${disabledId}.json`),
			'{"schemaVersion":"clawdi.hermesManifestSkillReceipt.v2"}\n',
		);
		mkdirSync(openClawLegacyReceiptDirectory, { recursive: true });
		writeFileSync(
			join(openClawLegacyReceiptDirectory, `${enabledSourcedId}.json`),
			'{"schemaVersion":"clawdi.openclawManifestSkillReceipt.v2"}\n',
		);
		mkdirSync(join(platformReceiptDirectory, "hermes"), { recursive: true });
		writeFileSync(join(platformReceiptDirectory, "hermes", "clawdi.json"), "{}\n");
		reserveManagedSkill({
			targetDir: enabledTarget,
			id: "clawdi",
			manager: "hosted-manifest",
			version: 1,
			digest: catalogEntry.digest,
		});
		reserveManagedSkill({
			targetDir: disabledTarget,
			id: disabledId,
			manager: "hosted-manifest",
			sourceIdentity: disabledSourceIdentity,
		});
		reserveManagedSkill({
			targetDir: openClawEnabledSourcedTarget,
			id: enabledSourcedId,
			manager: "hosted-manifest",
			sourceIdentity: enabledSourced.identity.sourceIdentity,
		});
		const manifest = baseManifest(
			paths,
			{
				hermes: {
					enabled: true,
					run: runSettings(hermesCommand, ["gateway"]),
					services: {},
				},
				openclaw: {
					enabled: true,
					run: runSettings(openClawCommand, ["gateway"]),
					services: {},
				},
			},
			{
				projection: {
					skills: {
						entries: {
							clawdi: { enabled: true, version: 1 },
							[enabledSourcedId]: { enabled: true, source: enabledSourcedSource },
							[disabledId]: { enabled: false, source: disabledSource },
						},
					},
				},
			},
		);
		const result = convergeRuntimeManifest(manifestLoad(manifest, "legacy-ledger-skills"), paths, {
			preparedHostedSourcedSkills: new Map([[enabledSourcedId, enabledSourced]]),
			hostedRuntimeContract: {
				expectedIdentity: {
					home: paths.userHome,
					user: runtimeUser,
					uid: runtimeUid,
					gid: runtimeGid,
				},
				resolveUserIdentity: () => ({ uid: runtimeUid, gid: runtimeGid }),
			},
		});

		expect([...result.installErrors, ...result.resourceProjectionErrors]).toEqual([]);
		expect(readFileSync(join(enabledTarget, "SKILL.md"))).toEqual(
			readFileSync(join(bundledSource, "SKILL.md")),
		);
		expect(existsSync(join(enabledTarget, ".clawdi-managed.json"))).toBe(false);
		expect(managedSkillReservationState(enabledTarget, "clawdi")).toBe("reserved");
		const ledger = JSON.parse(readFileSync(managedSkillReservationLedgerPath(), "utf8"));
		expect(ledger.reservations[enabledTarget].digest).toBe(catalogEntry.digest);
		expect(readFileSync(join(openClawEnabledSourcedTarget, "SKILL.md"), "utf8")).toBe(
			"# Current Review PR\n",
		);
		expect(ledger.reservations[openClawEnabledSourcedTarget]).toMatchObject({
			id: enabledSourcedId,
			digest: enabledSourced.identity.digest,
			sourceIdentity: enabledSourced.identity.sourceIdentity,
			manager: "hosted-manifest",
		});
		expect(existsSync(disabledTarget)).toBe(false);
		expect(managedSkillReservationState(disabledTarget, disabledId)).toBe("unreserved");
		expect(existsSync(legacyReceiptDirectory)).toBe(false);
		expect(existsSync(openClawLegacyReceiptDirectory)).toBe(false);
		expect(existsSync(platformReceiptDirectory)).toBe(false);
	});

	test("keeps the hosted skill ledger root owned while mutating the runtime-user skill tree", () => {
		if (process.geteuid?.() !== 0) return;
		const paths = tempRuntimePaths();
		const fixtureRoot = dirname(paths.serviceStateRoot);
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		const skillDir = join(paths.userHome, ".hermes", "skills", "clawdi");
		const ledger = join(paths.managedResourceRoot, "managed-skills.json");
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
		expect(() =>
			assertHostedBundledSkillCatalogDigest(resolveHostedBundledSkill("clawdi", 1), driftedSource),
		).toThrow("catalog digest mismatch");

		for (const path of protectedSourceAncestors) chmodSync(path, 0o700);
		const accountPrivilegeTool = ["run", "user"].join("");
		try {
			for (const path of protectedSourceAncestors) {
				expect(() =>
					execFileSync(accountPrivilegeTool, ["-u", "nobody", "--", "test", "-x", path]),
				).toThrow();
			}
			expect(() =>
				execFileSync(accountPrivilegeTool, [
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
			expect(statSync(paths.managedResourceRoot).uid).toBe(0);
			expect(statSync(paths.managedResourceRoot).mode & 0o777).toBe(0o755);
			expect(statSync(ledger).uid).toBe(0);
			expect(statSync(ledger).mode & 0o022).toBe(0);
			for (const path of protectedSourceAncestors) {
				expect(statSync(path).mode & 0o777).toBe(0o700);
			}

			expect(() =>
				execFileSync(accountPrivilegeTool, [
					"-u",
					"nobody",
					"--",
					"test",
					"-w",
					paths.managedResourceRoot,
				]),
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

	test("reconciles exact-source Hermes Workspace Skills through the reservation ledger", () => {
		const paths = tempRuntimePaths();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		mkdirSync(dirname(hermesCommand), { recursive: true });
		writeFileSync(hermesCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const source = {
			type: "github" as const,
			url: "https://github.com/Clawdi-AI/store",
			path: "skills/review-pr",
			commit: "a".repeat(40),
		};
		const prepared = preparedTestSourcedSkill("review-pr", source, "manifest-owned\n");
		const manifest = baseManifest(
			paths,
			{ hermes: { enabled: true, run: runSettings(hermesCommand, ["gateway"]), services: {} } },
			{ projection: { skills: { entries: { "review-pr": { enabled: true, source } } } } },
		);
		const skillDir = join(paths.userHome, ".hermes", "skills", "review-pr");
		const userOwnedSibling = join(paths.userHome, ".hermes", "skills", "user-owned");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "user-owned collision\n");
		const preparedSkills = new Map([[prepared.id, prepared]]);

		const collision = convergeRuntimeManifest(
			manifestLoad(manifest, "skill-ledger-collision"),
			paths,
			{ preparedHostedSourcedSkills: preparedSkills },
		);
		expect(collision.resourceProjectionErrors.join("\n")).toContain(
			`refusing to replace unmanaged review-pr skill at ${skillDir}`,
		);
		expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe("user-owned collision\n");
		rmSync(skillDir, { recursive: true, force: true });
		mkdirSync(userOwnedSibling, { recursive: true });
		writeFileSync(join(userOwnedSibling, "SKILL.md"), "keep me\n");

		const installed = convergeRuntimeManifest(
			manifestLoad({ ...manifest, generation: 2 }, "skill-ledger-install"),
			paths,
			{ preparedHostedSourcedSkills: preparedSkills },
		);
		expect([...installed.installErrors, ...installed.resourceProjectionErrors]).toEqual([]);
		expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe("manifest-owned\n");
		const ledger = JSON.parse(readFileSync(managedSkillReservationLedgerPath(), "utf8"));
		expect(ledger.reservations[skillDir]).toMatchObject({
			id: "review-pr",
			digest: prepared.identity.digest,
			sourceIdentity: prepared.identity.sourceIdentity,
			manager: "hosted-manifest",
		});

		const stableInode = statSync(skillDir).ino;
		const unchanged = convergeRuntimeManifest(
			manifestLoad({ ...manifest, generation: 3 }, "skill-ledger-unchanged"),
			paths,
			{ preparedHostedSourcedSkills: preparedSkills },
		);
		expect([...unchanged.installErrors, ...unchanged.resourceProjectionErrors]).toEqual([]);
		expect(statSync(skillDir).ino).toBe(stableInode);
		const movedSource = { ...source, commit: "c".repeat(40) };
		const movedPrepared = {
			...prepared,
			identity: {
				...prepared.identity,
				source: movedSource,
				sourceIdentity:
					"github\0review-pr\0https://github.com/Clawdi-AI/store\0skills/review-pr\0" +
					movedSource.commit,
			},
		};
		const moved = convergeRuntimeManifest(
			manifestLoad(
				{
					...manifest,
					generation: 4,
					projection: {
						skills: { entries: { "review-pr": { enabled: true, source: movedSource } } },
					},
				},
				"skill-ledger-source-moved",
			),
			paths,
			{ preparedHostedSourcedSkills: new Map([[movedPrepared.id, movedPrepared]]) },
		);
		expect([...moved.installErrors, ...moved.resourceProjectionErrors]).toEqual([]);
		expect(statSync(skillDir).ino).toBe(stableInode);
		expect(
			JSON.parse(readFileSync(managedSkillReservationLedgerPath(), "utf8")).reservations[skillDir]
				.sourceIdentity,
		).toBe(movedPrepared.identity.sourceIdentity);

		const removed = convergeRuntimeManifest(
			manifestLoad(
				{ ...manifest, generation: 5, projection: { skills: { entries: {} } } },
				"skill-ledger-remove",
			),
			paths,
			{ preparedHostedSourcedSkills: new Map() },
		);
		expect([...removed.installErrors, ...removed.resourceProjectionErrors]).toEqual([]);
		expect(existsSync(skillDir)).toBe(false);
		expect(managedSkillReservationState(skillDir, "review-pr")).toBe("unreserved");
		expect(readFileSync(join(userOwnedSibling, "SKILL.md"), "utf8")).toBe("keep me\n");
	});
	test("recovers a killed hosted Skill install before retrying convergence", async () => {
		const paths = tempRuntimePaths();
		ensureRuntimeStateDirs(paths);
		const skillId = "crash-recovery";
		const source = {
			type: "github" as const,
			url: "https://github.com/Clawdi-AI/store",
			path: `skills/${skillId}`,
			commit: "a".repeat(40),
		};
		const prepared = preparedTestSourcedSkill(skillId, source, "verified tree\n");
		const sourceIdentity = prepared.identity.sourceIdentity;
		const target = join(paths.userHome, ".hermes", "skills", skillId);
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "old committed tree\n");
		reserveManagedSkill({
			targetDir: target,
			id: skillId,
			digest: "a".repeat(64),
			sourceIdentity,
			manager: "hosted-manifest",
		});
		const ready = join(dirname(paths.serviceStateRoot), "skill-installer-ready");
		const moduleUrl = new URL("./managed-skill-reservation.ts", import.meta.url).href;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { writeFileSync } from "node:fs";
const { installReservedManagedSkill } = await import(${JSON.stringify(moduleUrl)});
installReservedManagedSkill(${JSON.stringify({
					targetDir: target,
					id: skillId,
					digest: prepared.identity.digest,
					sourceIdentity,
					manager: "hosted-manifest",
				})}, () => {
  writeFileSync(${JSON.stringify(ready)}, "ready");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}, { verify: () => true, discard: () => {} });`,
			],
			{ env: process.env, stdout: "pipe", stderr: "pipe" },
		);
		for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) {
			await Bun.sleep(10);
		}
		expect(existsSync(ready)).toBe(true);
		child.kill("SIGKILL");
		expect(await child.exited).not.toBe(0);

		const ledgerPath = managedSkillReservationLedgerPath();
		const interruptedLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
		expect(interruptedLedger.reservations[target].digest).toBe("a".repeat(64));
		expect(interruptedLedger.pendingReservations[target]).toBeDefined();
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("old committed tree\n");
		expect(() =>
			reserveManagedSkill({
				targetDir: target,
				id: skillId,
				sourceIdentity,
				manager: "hosted-manifest",
			}),
		).toThrow("pending installation that requires recovery");

		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		mkdirSync(dirname(hermesCommand), { recursive: true });
		writeFileSync(hermesCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const manifest = baseManifest(
			paths,
			{ hermes: { enabled: true, run: runSettings(hermesCommand, ["gateway"]), services: {} } },
			{ projection: { skills: { entries: { [skillId]: { enabled: true, source } } } } },
		);
		const result = convergeRuntimeManifest(
			manifestLoad(manifest, "recover-killed-skill-installer"),
			paths,
			{ preparedHostedSourcedSkills: new Map([[skillId, prepared]]) },
		);

		expect([...result.installErrors, ...result.resourceProjectionErrors]).toEqual([]);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("verified tree\n");
		expect(managedSkillReservationState(target, skillId)).toBe("reserved");
		const committedLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
		expect(committedLedger.reservations[target].digest).toBe(prepared.identity.digest);
		expect(committedLedger.pendingReservations).toEqual({});
	});

	test("releases a stale hosted reservation after its Skill tree disappears", () => {
		const paths = tempRuntimePaths();
		ensureRuntimeStateDirs(paths);
		mkdirSync(paths.managedResourceRoot, { recursive: true });
		const skillId = "attio-composio-client-updates";
		const sourceIdentity = `github\0${skillId}\0https://github.com/Clawdi-AI/store\0skills/${skillId}\0${"a".repeat(40)}`;
		const target = join(paths.userHome, ".hermes", "skills", skillId);
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		mkdirSync(dirname(hermesCommand), { recursive: true });
		writeFileSync(hermesCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "historical test Skill\n");
		reserveManagedSkill({
			targetDir: target,
			id: skillId,
			manager: "hosted-manifest",
			sourceIdentity,
		});
		rmSync(target, { recursive: true });

		const manifest = baseManifest(
			paths,
			{ hermes: { enabled: true, run: runSettings(hermesCommand, ["gateway"]), services: {} } },
			{ projection: { skills: { entries: {} } } },
		);
		const result = convergeRuntimeManifest(
			manifestLoad(manifest, "stale-absent-hermes-skill"),
			paths,
		);

		expect([...result.installErrors, ...result.resourceProjectionErrors]).toEqual([]);
		expect(managedSkillReservationState(target, skillId)).toBe("unreserved");
		expect(existsSync(target)).toBe(false);
	});

	test("isolates per-Skill resource failures without starving later Skills", () => {
		const paths = tempRuntimePaths();
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		mkdirSync(dirname(hermesCommand), { recursive: true });
		writeFileSync(hermesCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const skillIds = ["a-fail", "b-ready", "c-ready"];
		const preparedSkills = new Map<string, PreparedHostedSkill>();
		const entries: NonNullable<RuntimeManifest["projection"]>["skills"] = { entries: {} };
		for (const skillId of skillIds) {
			const source = {
				type: "github" as const,
				url: "https://github.com/Clawdi-AI/store",
				path: `skills/${skillId}`,
				commit: "a".repeat(40),
			};
			preparedSkills.set(skillId, preparedTestSourcedSkill(skillId, source, `${skillId}\n`));
			entries.entries[skillId] = { enabled: true, source };
		}
		const failed = preparedSkills.get("a-fail");
		if (!failed) throw new Error("missing failing Skill fixture");
		if (!("tarBytes" in failed)) throw new Error("failing Skill fixture is not sourced");
		failed.tarBytes = Buffer.from("invalid archive");
		failed.identity.digest = createHash("sha256").update(failed.tarBytes).digest("hex");
		const manifest = baseManifest(
			paths,
			{
				hermes: {
					enabled: true,
					run: runSettings(hermesCommand, ["gateway"]),
					services: {},
				},
			},
			{ projection: { skills: entries } },
		);
		const result = convergeRuntimeManifest(manifestLoad(manifest, "skill-item-isolation"), paths, {
			preparedHostedSourcedSkills: preparedSkills,
		});

		expect(result.installErrors).toEqual([]);
		expect(result.resourceProjectionErrors).toEqual([
			"runtime hermes Skill projection failed: a-fail: prepared Skill archive could not be staged",
		]);
		expect(existsSync(join(paths.userHome, ".hermes", "skills", "a-fail"))).toBe(false);
		for (const skillId of ["b-ready", "c-ready"]) {
			expect(
				readFileSync(join(paths.userHome, ".hermes", "skills", skillId, "SKILL.md"), "utf8"),
			).toBe(`${skillId}\n`);
		}
	});

	test("keeps unmanaged Skill rejection fail-closed across the Skill domain", () => {
		const paths = tempRuntimePaths();
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		mkdirSync(dirname(hermesCommand), { recursive: true });
		writeFileSync(hermesCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const skillIds = ["a-unmanaged", "b-ready", "c-ready"];
		const preparedSkills = new Map<string, PreparedHostedSkill>();
		const entries: NonNullable<RuntimeManifest["projection"]>["skills"] = { entries: {} };
		for (const skillId of skillIds) {
			const source = {
				type: "github" as const,
				url: "https://github.com/Clawdi-AI/store",
				path: `skills/${skillId}`,
				commit: "a".repeat(40),
			};
			preparedSkills.set(skillId, preparedTestSourcedSkill(skillId, source, `${skillId}\n`));
			entries.entries[skillId] = { enabled: true, source };
		}
		const unmanaged = join(paths.userHome, ".hermes", "skills", "a-unmanaged");
		mkdirSync(unmanaged, { recursive: true });
		writeFileSync(join(unmanaged, "SKILL.md"), "tenant owned\n");
		const manifest = baseManifest(
			paths,
			{
				hermes: {
					enabled: true,
					run: runSettings(hermesCommand, ["gateway"]),
					services: {},
				},
			},
			{ projection: { skills: entries } },
		);
		const result = convergeRuntimeManifest(
			manifestLoad(manifest, "skill-domain-integrity"),
			paths,
			{
				preparedHostedSourcedSkills: preparedSkills,
			},
		);

		expect(result.resourceProjectionErrors.join("\n")).toContain(
			`refusing to replace unmanaged a-unmanaged skill at ${unmanaged}`,
		);
		expect(readFileSync(join(unmanaged, "SKILL.md"), "utf8")).toBe("tenant owned\n");
		expect(existsSync(join(paths.userHome, ".hermes", "skills", "b-ready"))).toBe(false);
		expect(existsSync(join(paths.userHome, ".hermes", "skills", "c-ready"))).toBe(false);
	});

	test("installs a bundled OpenClaw Skill from cleaned runtime-readable staging", () => {
		const paths = tempRuntimePaths();
		const command = join(paths.userHome, ".local", "bin", "openclaw");
		const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
		const sourceLog = join(dirname(paths.serviceStateRoot), "openclaw-skill-source.log");
		writeFakeGatewayCli({
			path: command,
			runtime: "openclaw",
			unitPath,
			skillInstallSourceLog: sourceLog,
		});
		const manifest = baseManifest(
			paths,
			{ openclaw: { enabled: true, run: runSettings(command, ["gateway"]), services: {} } },
			{ projection: { skills: { entries: { clawdi: { enabled: true, version: 1 } } } } },
		);
		const target = join(paths.userHome, ".openclaw", "workspace", "skills", "clawdi");
		const packageSource = resolve(
			import.meta.dir,
			"../..",
			"skills",
			"hosted-versions",
			"1",
			"clawdi",
		);

		const result = convergeRuntimeManifest(manifestLoad(manifest, "bundled-openclaw-skill"), paths);

		expect(result.installErrors).toEqual([]);
		const stagedSource = readFileSync(sourceLog, "utf8").trim();
		expect(stagedSource).not.toBe(packageSource);
		expect(stagedSource.startsWith(join(tmpdir(), "clawdi-managed-skill-"))).toBe(true);
		expect(existsSync(stagedSource)).toBe(false);
		expect(readFileSync(join(target, "SKILL.md"))).toEqual(
			readFileSync(join(packageSource, "SKILL.md")),
		);
		expect(statSync(target).mode & 0o777).toBe(0o755);
		expect(statSync(join(target, "SKILL.md")).mode & 0o777).toBe(0o644);
		expect(existsSync(join(target, ".clawdi-managed.json"))).toBe(false);
		expect(shouldIgnoreUserSkill(target, "clawdi")).toBe(true);

		const targetBeforeRetiredReceipts = statSync(target).ino;
		const legacyReceiptDirectory = join(dirname(target), ".clawdi-manifest-receipts");
		const platformReceiptDirectory = join(paths.managedResourceRoot, "skill-receipts");
		mkdirSync(legacyReceiptDirectory, { recursive: true });
		writeFileSync(join(legacyReceiptDirectory, "clawdi.json"), "{}\n");
		mkdirSync(join(platformReceiptDirectory, "openclaw"), { recursive: true });
		writeFileSync(join(platformReceiptDirectory, "openclaw", "clawdi.json"), "{}\n");
		const reconverged = convergeRuntimeManifest(
			manifestLoad({ ...manifest, generation: 2 }, "bundled-openclaw-skill-retired-receipts"),
			paths,
		);
		expect([...reconverged.installErrors, ...reconverged.resourceProjectionErrors]).toEqual([]);
		expect(statSync(target).ino).toBe(targetBeforeRetiredReceipts);
		expect(readFileSync(sourceLog, "utf8").trim().split("\n")).toHaveLength(1);
		expect(existsSync(legacyReceiptDirectory)).toBe(false);
		expect(existsSync(platformReceiptDirectory)).toBe(false);

		const targetBeforeRepair = statSync(target).ino;
		writeFileSync(join(target, "SKILL.md"), "tenant mutation\n");
		const repaired = convergeRuntimeManifest(
			manifestLoad({ ...manifest, generation: 3 }, "bundled-openclaw-skill-repair"),
			paths,
		);
		expect([...repaired.installErrors, ...repaired.resourceProjectionErrors]).toEqual([]);
		expect(readFileSync(join(target, "SKILL.md"))).toEqual(
			readFileSync(join(packageSource, "SKILL.md")),
		);
		expect(statSync(target).ino).not.toBe(targetBeforeRepair);

		writeFileSync(join(target, "SKILL.md"), "tenant mutation\n");
		rmSync(managedSkillReservationLedgerPath(), { force: true });
		const withoutLedger = convergeRuntimeManifest(
			manifestLoad({ ...manifest, generation: 4 }, "bundled-openclaw-skill-restart"),
			paths,
		);
		expect(withoutLedger.installErrors).toEqual([]);
		expect(withoutLedger.resourceProjectionErrors.join("\n")).toContain(
			`refusing to replace unmanaged clawdi skill at ${target}`,
		);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("tenant mutation\n");
		expect(shouldIgnoreUserSkill(target, "clawdi")).toBe(false);
	});

	test("ignores legacy OpenClaw markers without reservation-backed ownership", () => {
		const paths = tempRuntimePaths();
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		const command = join(paths.userHome, ".local", "bin", "openclaw");
		writeFakeGatewayCli({
			path: command,
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
		});
		const openClawWorkspaceRoot = join(paths.userHome, ".openclaw", "workspace");
		const target = join(openClawWorkspaceRoot, "skills", "clawdi");
		const source = resolve(import.meta.dir, "../..", "skills", "hosted-versions", "1", "clawdi");
		mkdirSync(dirname(target), { recursive: true });
		cpSync(source, target, { recursive: true });
		chmodSync(target, 0o755);
		chmodSync(join(target, "SKILL.md"), 0o644);
		writeFileSync(
			join(target, ".clawdi-managed.json"),
			`${JSON.stringify({ managedBy: "clawdi runtime init", skillName: "clawdi" })}\n`,
		);
		const manifest = baseManifest(
			paths,
			{ openclaw: { enabled: true, run: runSettings(command, ["gateway"]), services: {} } },
			{ projection: { skills: { entries: {} } } },
		);
		const result = convergeRuntimeManifest(manifestLoad(manifest, "legacy-openclaw-remove"), paths);
		expect(result.installErrors).toEqual([]);
		expect(existsSync(target)).toBe(true);
		expect(existsSync(join(target, ".clawdi-managed.json"))).toBe(true);
	});

	test("restores exact root and runtime-user targets before systemd rollback reconciliation", () => {
		const paths = tempRuntimePaths();
		const workspaceRoot = join(paths.userHome, "clawdi");
		const commandPath = join(paths.userHome, ".local", "bin", "openclaw");
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
		writeFakeGatewayCli({
			path: commandPath,
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
			configPatchPath: targetConfig,
		});
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
				quiesce: () => {},
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
		expect(result.resourceProjectionErrors).toEqual([]);
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

	test("keeps stale unit authority through commit while declaratively disabling user units", () => {
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
		const staleEnablementFiles = [staleUserWant, staleDropInWant];
		const retainedStaleFiles = staleFiles.filter((path) => !staleEnablementFiles.includes(path));
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
					for (const path of retainedStaleFiles) expect(existsSync(path)).toBe(true);
					for (const path of staleEnablementFiles) expect(existsSync(path)).toBe(false);
					committed = true;
				},
				systemdApply: {
					quiesce: () => {},
					activateEgressPrerequisite: successfulPrerequisiteActivation,
					activate: (signal) => {
						expect(signal.staleSystemUnits).toEqual(["clawdi-runtime-sidecar.service"]);
						expect(signal.staleUserUnits).toEqual([
							"clawdi-old.service",
							"openclaw-gateway.service",
						]);
						for (const path of retainedStaleFiles) expect(existsSync(path)).toBe(true);
						for (const path of staleEnablementFiles) expect(existsSync(path)).toBe(false);
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
		const openClawWorkspaceRoot = join(paths.userHome, ".openclaw", "workspace");
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
		const openClawAgentDirectory = join(paths.userHome, ".openclaw", "agents", "main", "agent");

		expect(snapshotPaths).toEqual(
			[
				paths.managedConfig,
				paths.syncState,
				paths.egressEngineStatus,
				paths.manifestLastGood,
				paths.managedSecretCacheFile,
				paths.appliedState,
				paths.oauthCredentialRoot,
				paths.installReceipts,
				paths.runConfigRoot,
				paths.egressProfileBundle,
				paths.installInventory,
				paths.managedResourceRoot,
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
				paths.liveSyncEnvironmentIndex,
				join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
				join(paths.systemdSystemRoot, "clawdi-daemon.service"),
				join(paths.systemdSystemRoot, "clawdi-runtime-sidecar.service"),
				existingSystemUnit,
				existingSystemDropIn,
			].sort(),
		);
		expect(runtimeUserMutationTargets(manifest, paths, openClawWorkspaceRoot, new Map())).toEqual(
			expect.arrayContaining([
				join(paths.userHome, ".hermes", "auth.json"),
				join(paths.userHome, ".hermes", "auth.lock"),
				openClawAgentDirectory,
			]),
		);
		for (const userWritablePath of [
			paths.serviceStateRoot,
			paths.runRoot,
			paths.userHome,
			workspaceRoot,
			join(openClawWorkspaceRoot, "SOUL.md"),
			join(paths.userHome, ".openclaw", "openclaw.json"),
			join(paths.userHome, ".hermes", "config.yaml"),
			join(paths.userHome, ".hermes", "SOUL.md"),
			join(paths.userHome, ".hermes", "plugins", "model-providers", "clawdi"),
			join(paths.userHome, ".codex", "config.toml"),
			join(openClawWorkspaceRoot, "skills", "clawdi"),
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
		expect(
			convergeRuntimeManifest(
				manifestLoad(baseManifest(paths, {}), "inline-writable-private-root"),
				paths,
			).installErrors,
		).toEqual([]);

		for (const key of ["runConfigRoot", "systemdEnvRoot"] as const) {
			const unsafePaths = tempRuntimePaths();
			ensureRuntimeStateDirs(unsafePaths);
			chmodSync(dirname(unsafePaths.serviceStateRoot), 0o755);
			chmodSync(unsafePaths.configurationRoot, 0o755);
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
		).toThrow(`trusted directory path contains a non-directory: ${symlinkPaths.runConfigRoot}`);
	});

	test("snapshots exact installer targets only when installation is planned", () => {
		const paths = tempRuntimePaths();
		const home = paths.userHome;
		const install = (runtime: "openclaw" | "hermes") => ({
			authority: "official" as const,
			method: "official-installer" as const,
			url: OFFICIAL_INSTALL_URLS[runtime],
			home,
			args: officialInstallArgs(runtime, home),
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
			join(home, ".hermes", "config.yaml"),
			join(home, ".hermes", "SOUL.md"),
			join(home, ".hermes", "skills"),
			join(home, ".local", "bin", "hermes"),
			join(home, ".local", "bin", "hermes-agent"),
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
		expect(dashboardTargets).not.toContain(join(largeInstalledTree, "hermes_cli", "web_dist"));
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
		).toEqual([]);
	});

	test("runs the official latest OpenClaw installer with a sanitized environment and timeout", () => {
		const paths = tempRuntimePaths();
		const home = paths.userHome;
		const commandPath = join(home, ".local", "bin", "openclaw");
		const configPath = join(home, ".openclaw", "openclaw.json");
		const installedVersionPath = join(home, ".openclaw", "installed-version");
		const fixtureRoot = dirname(paths.serviceStateRoot);
		const commandFixturePath = join(fixtureRoot, "openclaw");
		const installerPath = join(fixtureRoot, "install-openclaw.sh");
		const installerResultPath = join(fixtureRoot, "installer-result");
		const installerLog = join(fixtureRoot, "installer.log");
		const installerEnvironmentLog = join(fixtureRoot, "installer-environment.log");
		const installedVersion = "2026.7.1-2";
		const configWriterVersion = "2026.8.1.beta.1";
		const openClawInstallerOverrides = [
			"OPENCLAW_HOME",
			"OPENCLAW_STATE_DIR",
			"OPENCLAW_CONFIG_PATH",
			"OPENCLAW_PREFIX",
			"OPENCLAW_VERSION",
			"OPENCLAW_INSTALL_METHOD",
			"OPENCLAW_GIT_DIR",
			"OPENCLAW_GIT_UPDATE",
		] as const;
		const config = {
			meta: {
				lastTouchedVersion: configWriterVersion,
				migrations: { applied: ["agents.entries"] },
			},
			agents: { entries: [{ id: "main" }] },
		};

		mkdirSync(dirname(commandPath), { recursive: true });
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(installedVersionPath, `${installedVersion}\n`);
		writeFileSync(configPath, `${JSON.stringify(config)}\n`);
		writeFileSync(
			commandFixturePath,
			`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "--version") printf 'OpenClaw %s\n' "$(cat '${installedVersionPath}')" ;;
  "agents list --json") printf '[{"id":"main","workspace":"%s"}]\n' "$HOME/.openclaw/workspace" ;;
  *) exit 0 ;;
esac
`,
		);
		chmodSync(commandFixturePath, 0o700);
		writeFileSync(
			installerPath,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$#" "$@" >> '${installerLog}'
printf '%s\n' "$HOME" > '${installerEnvironmentLog}'
for name in ${openClawInstallerOverrides.join(" ")}; do
  if [ "\${!name+x}" = x ]; then printf '%s\n' "$name" >> '${installerEnvironmentLog}'; fi
done
cp '${installerResultPath}' '${installedVersionPath}'
cp '${commandFixturePath}' '${commandPath}'
`,
		);
		chmodSync(installerPath, 0o700);
		Object.assign(process.env, {
			OPENCLAW_HOME: "stale-openclaw-home",
			OPENCLAW_STATE_DIR: dirname(configPath),
			OPENCLAW_CONFIG_PATH: configPath,
			OPENCLAW_PREFIX: "stale-openclaw-prefix",
			OPENCLAW_VERSION: "stale-openclaw-version",
			OPENCLAW_INSTALL_METHOD: "stale-openclaw-install-method",
			OPENCLAW_GIT_DIR: "stale-openclaw-git-dir",
			OPENCLAW_GIT_UPDATE: "stale-openclaw-git-update",
		});
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = `file://${installerPath}`;
		process.env.CLAWDI_RUNTIME_INSTALL_TIMEOUT = "invalid";

		const install = {
			authority: "official" as const,
			method: "official-installer" as const,
			url: OFFICIAL_INSTALL_URLS.openclaw,
			home,
			args: officialInstallArgs("openclaw", home),
		};
		const load = manifestLoad(
			baseManifest(paths, {
				openclaw: {
					enabled: true,
					install,
					run: runSettings(commandPath, ["gateway", "run"]),
					services: {},
				},
			}),
			"hosted-v2-openclaw-official-latest",
		);

		writeFileSync(installerResultPath, `${installedVersion}\n`);
		const warnings: string[] = [];
		const originalWarn = console.warn;
		let converged: ReturnType<typeof convergeRuntimeManifest>;
		try {
			console.warn = (message) => warnings.push(String(message));
			converged = convergeRuntimeManifest(load, paths, {
				executeOfficialServiceInstallers: false,
			});
		} finally {
			console.warn = originalWarn;
		}
		expect(converged.installErrors).toEqual([]);
		expect(warnings).toEqual([
			"CLAWDI_RUNTIME_INSTALL_TIMEOUT must be a valid positive integer; using 1800000ms",
		]);
		expect(execFileSync(commandPath, ["--version"], { encoding: "utf8" }).trim()).toBe(
			`OpenClaw ${installedVersion}`,
		);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(config);
		expect(readFileSync(installerEnvironmentLog, "utf8").trim().split("\n")).toEqual([home]);
		const expectedArgs = officialInstallArgs("openclaw", home);
		expect(readFileSync(installerLog, "utf8").trim().split("\n")).toEqual([
			String(expectedArgs.length),
			...expectedArgs,
		]);
		const inventory = JSON.parse(
			readFileSync(join(paths.installInventory, "openclaw.json"), "utf8"),
		) as Record<string, unknown>;
		expect(inventory.installerArgs).toEqual(expectedArgs);
		expect(inventory).not.toHaveProperty("command");
		expect(expectedArgs).not.toContain("--version");
	});

	test("accepts an installed runtime command symlink as an exact transaction target", () => {
		const paths = tempRuntimePaths();
		const appRoot = join(paths.userHome, ".openclaw");
		const commandPath = join(paths.userHome, ".local", "bin", "openclaw");
		const commandTarget = join(appRoot, "openclaw-entrypoint");
		mkdirSync(dirname(commandPath), { recursive: true });
		mkdirSync(dirname(commandTarget), { recursive: true });
		writeFileSync(
			commandTarget,
			`#!/bin/sh
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"%s"}]\\n' "$HOME/.openclaw/workspace"
fi
exit 0
`,
		);
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
					args: officialInstallArgs("openclaw", paths.userHome),
				},
				run: runSettings(commandPath, ["gateway", "run"]),
				services: {},
			},
		});

		const result = convergeRuntimeManifest(manifestLoad(manifest, "symlinked-openclaw"), paths);
		expect(result.installErrors).toEqual([]);
		expect(readlinkSync(commandPath)).toBe(commandTarget);
	});

	test("keeps the systemd enclave root-owned outside the UID 10001 installer boundary", () => {
		const numericPrivilegeToolPath = ["/usr/bin/set", "priv"].join("");
		if (process.geteuid?.() !== 0 || !existsSync(numericPrivilegeToolPath)) return;
		const paths = tempRuntimePaths();
		const fixtureRoot = dirname(paths.serviceStateRoot);
		const runtimeUid = 10_001;
		const runtimeGid = 10_001;
		const appRoot = join(paths.userHome, ".openclaw");
		const binDir = join(paths.userHome, ".local", "bin");
		const commandPath = join(binDir, "openclaw");
		const gatewayEnvironment = join(appRoot, "gateway.systemd.env");
		const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
		const unitBackupPath = `${unitPath}.bak`;
		const dropInPath = join(
			paths.systemdUserRoot,
			"openclaw-gateway.service.d",
			"10-clawdi-hosted.conf",
		);
		const wantsRoot = join(paths.systemdUserRoot, "default.target.wants");
		const enablementPath = join(wantsRoot, "openclaw-gateway.service");
		const runtimeOwnedPaths = [
			appRoot,
			binDir,
			commandPath,
			dirname(dirname(paths.systemdUserRoot)),
			dirname(paths.systemdUserRoot),
		];
		const platformOwnedPaths = [
			paths.systemdUserRoot,
			unitPath,
			unitBackupPath,
			gatewayEnvironment,
			dirname(dropInPath),
			dropInPath,
			wantsRoot,
			enablementPath,
		];
		const skillProjectionLog = join(appRoot, "skill-projection-owners.log");

		chmodSync(fixtureRoot, 0o755);
		mkdirSync(paths.userHome, { recursive: true });
		chownSync(paths.userHome, runtimeUid, runtimeGid);
		chmodSync(paths.userHome, 0o700);
		mkdirSync(paths.clawdiHome, { recursive: true });
		chownSync(paths.clawdiHome, runtimeUid, runtimeGid);
		chmodSync(paths.clawdiHome, 0o700);
		mkdirSync(binDir, { recursive: true });
		mkdirSync(appRoot, { recursive: true });
		mkdirSync(dirname(dropInPath), { recursive: true });
		mkdirSync(wantsRoot, { recursive: true });
		writeFileSync(
			commandPath,
			`#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = "10001"
case "$*" in
  "--version")
    printf '%s\\n' 'OpenClaw test-version'
    ;;
  "agents list --json")
    printf '[{"id":"main","workspace":"%s"}]\\n' "$HOME/.openclaw/workspace"
    ;;
  "skills install "*)
    : > '${skillProjectionLog}'
    ${platformOwnedPaths.map((path) => `stat -c '%u:%g' '${path}' >> '${skillProjectionLog}'`).join("\n    ")}
    exit 45
    ;;
  "gateway install --force --json")
    unit="$HOME/.config/systemd/user/\${OPENCLAW_SYSTEMD_UNIT:-openclaw-gateway.service}"
    cp "$unit" "$unit.bak"
    printf '%s\\n' '[Unit]' '[Service]' 'ExecStart=openclaw gateway run' > "$unit"
    printf '%s\\n' 'OPENCLAW_OFFICIAL_USER_STATE=1' > "$HOME/.openclaw/gateway.systemd.env"
    chmod 0600 "$HOME/.openclaw/gateway.systemd.env"
    printf '{"ok":true}\\n'
    ;;
  *) exit 64 ;;
esac
`,
		);
		writeFileSync(unitPath, "[Unit]\nDescription=previous official unit\n");
		writeFileSync(unitBackupPath, "previous official backup\n");
		writeFileSync(dropInPath, "[Service]\nEnvironment=PREVIOUS=1\n");
		symlinkSync("../openclaw-gateway.service", enablementPath);
		writeFileSync(gatewayEnvironment, "PREVIOUS_OFFICIAL_STATE=1\n");
		for (const path of [appRoot, binDir]) {
			chownSync(path, 0, 0);
			chmodSync(path, 0o700);
		}
		for (const path of [commandPath, ...platformOwnedPaths]) {
			if (lstatSync(path).isSymbolicLink()) continue;
			chownSync(path, 0, 0);
			chmodSync(path, 0o700);
		}
		for (const path of [enablementPath]) lchownSync(path, 0, 0);
		chmodSync(unitPath, 0o600);
		chmodSync(unitBackupPath, 0o600);
		chmodSync(dropInPath, 0o600);
		chmodSync(gatewayEnvironment, 0o600);

		process.env.CLAWDI_RUNTIME_USER = "clawdi";
		process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
		process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);
		const hostedRuntimeContract = {
			expectedIdentity: {
				home: paths.userHome,
				user: "clawdi",
				uid: runtimeUid,
				gid: runtimeGid,
			},
			resolveUserIdentity: () => ({ uid: runtimeUid, gid: runtimeGid }),
		};
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
						args: officialInstallArgs("openclaw", paths.userHome),
					},
					run: runSettings(commandPath, ["gateway", "run"]),
					services: {},
				},
			},
			{ projection: { skills: { entries: { clawdi: { enabled: true, version: 1 } } } } },
		);

		const result = convergeRuntimeManifest(
			manifestLoad(manifest, "root-openclaw-ownership"),
			paths,
			{
				executeOfficialServiceInstallers: false,
				hostedRuntimeContract,
			},
		);
		expect(result.installErrors).toEqual([]);
		expect(result.resourceProjectionErrors.join("\n")).toContain(
			"OpenClaw official Skill install failed: exit code 45 without output",
		);
		expect(readFileSync(skillProjectionLog, "utf8").trim().split("\n")).toEqual(
			platformOwnedPaths.map(() => "0:0"),
		);
		for (const path of runtimeOwnedPaths) {
			const node = lstatSync(path);
			expect([node.uid, node.gid]).toEqual([runtimeUid, runtimeGid]);
		}
		for (const path of platformOwnedPaths) {
			const node = lstatSync(path);
			expect([node.uid, node.gid]).toEqual([0, 0]);
		}
		expect(statSync(appRoot).mode & 0o777).toBe(0o700);
		expect(statSync(commandPath).mode & 0o777).toBe(0o700);
		expect(statSync(gatewayEnvironment).mode & 0o777).toBe(0o600);
		expect([statSync(paths.daemonAuthToken).uid, statSync(paths.daemonAuthToken).gid]).toEqual([
			0, 0,
		]);
		expect(statSync(paths.daemonAuthToken).mode & 0o777).toBe(0o600);

		rmSync(enablementPath);
		symlinkSync("../unexpected.service", enablementPath);
		lchownSync(enablementPath, 0, 0);
		let installerBoundaryObserved = false;
		const installed = convergeRuntimeManifest(
			manifestLoad({ ...manifest, generation: 2 }, "root-openclaw-installer-boundary"),
			paths,
			{
				hostedRuntimeContract,
				systemdApply: {
					quiesce: () => {},
					activateEgressPrerequisite: successfulPrerequisiteActivation,
					installOfficialService: (_unitName, install) => {
						installerBoundaryObserved = true;
						for (const path of [
							paths.systemdUserRoot,
							unitPath,
							unitBackupPath,
							gatewayEnvironment,
						]) {
							const node = lstatSync(path);
							expect([node.uid, node.gid]).toEqual([runtimeUid, runtimeGid]);
						}
						for (const path of [dirname(dropInPath), dropInPath, wantsRoot, enablementPath]) {
							const node = lstatSync(path);
							expect([node.uid, node.gid]).toEqual([0, 0]);
						}
						expect(readlinkSync(enablementPath)).toBe("../openclaw-gateway.service");
						return install();
					},
					activate: (signal) => {
						expect(signal.reloadUserUnits).toEqual(["openclaw-gateway.service"]);
						return successfulPrerequisiteActivation();
					},
					rollback: () => {},
				},
			},
		);
		expect(installed.installErrors).toEqual([]);
		expect(installerBoundaryObserved).toBe(true);
		for (const path of platformOwnedPaths) {
			const node = lstatSync(path);
			expect([node.uid, node.gid]).toEqual([0, 0]);
		}
		expect(statSync(gatewayEnvironment).mode & 0o777).toBe(0o600);

		for (const path of runtimeOwnedPaths) chownSync(path, 0, 0);
		const beforeRollback = new Map(
			[...runtimeOwnedPaths, ...platformOwnedPaths].map(
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
			manifestLoad({ ...manifest, generation: 3 }, "root-openclaw-ownership-rollback"),
			paths,
			{
				cacheLastGood: false,
				commitAuthority: () => {
					throw new Error("injected ownership commit failure");
				},
				executeOfficialServiceInstallers: false,
				hostedRuntimeContract,
			},
		);
		expect(failed.installErrors.join("\n")).toContain("injected ownership commit failure");
		for (const [path, previous] of beforeRollback) {
			const node = lstatSync(path);
			const expectedOwner = platformOwnedPaths.includes(path) ? [0, 0] : [runtimeUid, runtimeGid];
			expect([node.uid, node.gid]).toEqual(expectedOwner);
			expect(node.mode & 0o777).toBe(previous.mode);
			if (previous.content) expect(readFileSync(path)).toEqual(previous.content);
		}
		expect([statSync(paths.daemonAuthToken).uid, statSync(paths.daemonAuthToken).gid]).toEqual([
			0, 0,
		]);
		expect(statSync(paths.daemonAuthToken).mode & 0o777).toBe(0o600);
	});

	test("restores exact installer targets before Apply when installation fails", () => {
		const paths = tempRuntimePaths();
		const home = paths.userHome;
		const binDir = join(home, ".local", "bin");
		const toolsDir = join(home, ".local", "tools");
		const existingToolFile = join(toolsDir, "cache", "keep.txt");
		const commandPath = join(binDir, "openclaw");
		const installerPath = join(dirname(home), "openclaw-failing-installer.sh");
		const installerLog = join(dirname(home), "openclaw-failing-installer.log");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(dirname(existingToolFile), { recursive: true });
		writeFileSync(existingToolFile, "original-tool\n");
		chmodSync(binDir, 0o750);
		chmodSync(toolsDir, 0o700);
		chmodSync(existingToolFile, 0o600);
		writeFileSync(
			installerPath,
			`#!/usr/bin/env bash
set -euo pipefail
printf 'ran\n' > '${installerLog}'
chmod 0777 '${binDir}' '${toolsDir}'
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
					args: officialInstallArgs("openclaw", home),
				},
				run: runSettings(commandPath, ["gateway", "run"]),
				services: {},
			},
		});
		let activateCalls = 0;
		let rollbackCalls = 0;
		const result = convergeRuntimeManifest(manifestLoad(manifest, "installer-failure"), paths, {
			systemdApply: {
				quiesce: () => {},
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: () => {
					activateCalls += 1;
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
				rollback: () => rollbackCalls++,
			},
		});

		expect(result.installErrors.join("\n")).toContain("runtime openclaw installer exited 42");
		expect(readFileSync(installerLog, "utf8")).toBe("ran\n");
		expect(activateCalls).toBe(0);
		expect(rollbackCalls).toBe(0);
		expect(readFileSync(existingToolFile, "utf8")).toBe("original-tool\n");
		expect(existsSync(commandPath)).toBe(false);
		expect(existsSync(join(toolsDir, "new.txt"))).toBe(false);
		expect(statSync(binDir).mode & 0o777).toBe(0o750);
		expect(statSync(toolsDir).mode & 0o777).toBe(0o700);
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
		const localRoot = join(home, ".local");
		const toolsPath = join(localRoot, "tools");
		const commandPath = join(localRoot, "bin", "openclaw");
		const redirectedTools = join(dirname(home), "redirected-openclaw-tools");
		const installerPath = join(dirname(home), "must-not-run-installer.sh");
		const installerLog = join(dirname(home), "must-not-run-installer.log");
		mkdirSync(localRoot, { recursive: true });
		mkdirSync(redirectedTools, { recursive: true });
		symlinkSync(redirectedTools, toolsPath);
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
					args: officialInstallArgs("openclaw", home),
				},
				run: runSettings(commandPath, ["gateway", "run"]),
				services: {},
			},
		});

		expect(() =>
			convergeRuntimeManifest(manifestLoad(manifest, "symlinked-installer-target"), paths),
		).toThrow(`runtime-user mutation path contains a symlink: ${toolsPath}`);
		expect(existsSync(installerLog)).toBe(false);
	});

	test("rejects a malformed Hermes MCP patch before Apply", () => {
		const paths = tempRuntimePaths();
		const hermesCommand = join(paths.userHome, ".local", "bin", "hermes");
		const hermesConfig = join(paths.userHome, ".hermes", "config.yaml");
		writeFakeGatewayCli({
			path: hermesCommand,
			runtime: "hermes",
			unitPath: join(paths.systemdUserRoot, "hermes-gateway.service"),
		});
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
					run: runSettings(hermesCommand, ["gateway", "run"]),
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
		writeFakeGatewayCli({
			path: join(paths.userHome, ".local", "bin", "openclaw"),
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
		});
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
		writeFakeGatewayCli({
			path: join(paths.userHome, ".local", "bin", "openclaw"),
			runtime: "openclaw",
			unitPath: join(paths.systemdUserRoot, "openclaw-gateway.service"),
		});
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

	test("installs the pinned Files companion post-boot and reconverges idempotently", () => {
		const paths = tempRuntimePaths();
		const binary = "#!/bin/sh\nprintf 'test File Browser'\n";
		const manifest = fileBrowserManifest(paths, { generation: 1, binary });
		let downloads = 0;
		let activations = 0;
		let authorityCommits = 0;
		const options = {
			fileBrowserInstallOptions: {
				serviceIsolation: testFileBrowserServiceIsolation,
				download: (_url: string, destination: string) => {
					downloads++;
					writeFileSync(destination, binary);
				},
				versionProbe: () => `${FILE_BROWSER_VERSION} ${FILE_BROWSER_COMMIT.slice(0, 7)}`,
			},
			fileBrowserReadinessProbe: (url: string) => url === "http://127.0.0.1:9120/health",
			systemdApply: fileBrowserApplyHooks({ onActivate: () => activations++ }),
			commitAuthority: () => authorityCommits++,
		};

		const first = convergeRuntimeManifest(fileBrowserManifestLoad(manifest), paths, options);
		expect(first.installErrors).toEqual([]);
		expect(downloads).toBe(1);
		expect(activations).toBe(1);
		expect(authorityCommits).toBe(1);
		const active = fileBrowserBinaryPath(paths, binary);
		expect(readFileSync(active, "utf8")).toBe(binary);
		const config = readFileSync(paths.fileBrowserConfig, "utf8");
		expect(parseYaml(config)).toMatchObject({
			server: {
				sources: [
					{
						config: {
							rules: [{ folderPath: "/", ignoreSymlinks: true }],
						},
					},
				],
			},
			userDefaults: {
				sidebar: { sticky: false },
				listing: { showHidden: true },
				account: {
					lockPassword: true,
					disableSettings: false,
					loginMethod: "jwt",
					permissions: {
						admin: false,
						api: false,
						modify: true,
						share: false,
						realtime: false,
						delete: true,
						create: true,
						download: true,
					},
				},
			},
		});
		expect(config).toContain("listen: 0.0.0.0");
		expect(config).toContain("port: 9120");
		expect(config).toContain("path: /home/clawdi");
		expect(config).not.toContain("ignoreHidden");
		expect(config).toContain("ignoreSymlinks: true");
		expect(config).toContain("disableWebDAV: true");
		expect(config).toContain("password:\n      enabled: false");
		expect(config).toContain("share: false");
		const unitPath = join(paths.systemdSystemRoot, "clawdi-files.service");
		const unit = readFileSync(unitPath, "utf8");
		expect(first.outputs.systemdSystemUnits).toContain(unitPath);
		expect(first.outputs.systemdUserUnits).not.toContain(
			join(paths.systemdUserRoot, "clawdi-files.service"),
		);
		expect(unit).not.toContain("RootDirectory=");
		expect(unit).toContain(`User=${TEST_RUNTIME_USER}`);
		expect(unit).toContain(`Group=${process.getegid?.() ?? 0}`);
		expect(unit).toContain("ProtectHome=tmpfs");
		expect(unit).toContain(`BindPaths=${paths.userHome}`);
		expect(unit).toContain("StateDirectory=clawdi-files");
		expect(unit).toContain("StateDirectoryMode=0700");
		expect(unit).toContain("RuntimeDirectory=clawdi-files");
		expect(unit).toContain("RuntimeDirectoryMode=0700");
		expect(unit).not.toContain("OpenFile=");
		expect(unit).not.toContain("LoadCredential=");
		expect(unit).toContain(`ReadWritePaths=${paths.userHome}`);
		expect(unit).toContain(`BindReadOnlyPaths=${active}:${paths.fileBrowserServiceBinary}:norbind`);
		expect(unit).toContain(
			`BindReadOnlyPaths=${paths.fileBrowserConfig}:${dirname(paths.fileBrowserServiceBinary)}/filebrowser.yaml:norbind`,
		);
		expect(unit).toContain('ExecStartPre="/bin/sh" "-c"');
		expect(unit).toContain(paths.fileBrowserServiceBinary);
		expect(unit).toContain(FILE_BROWSER_VERSION);
		expect(unit).toContain(FILE_BROWSER_COMMIT.slice(0, 7));
		expect(unit.split("\n")).not.toContain(`ReadOnlyPaths=${paths.fileBrowserConfig}`);
		expect(unit.match(/^ExecStart=.*$/m)?.[0]).toBe(
			`ExecStart="${paths.fileBrowserServiceBinary}" "-c" "${dirname(paths.fileBrowserServiceBinary)}/filebrowser.yaml"`,
		);
		expect(unit).toContain(`NoExecPaths=${paths.userHome} ${paths.fileBrowserStateRoot}`);
		expect(unit).toContain("ProtectSystem=strict");
		expect(unit).toContain("PrivatePIDs=true");
		expect(unit).toContain("CapabilityBoundingSet=");
		expect(unit).toContain("TasksMax=128");
		expect(unit).toContain(
			`EnvironmentFile=${join(paths.systemdEnvRoot, "clawdi-files.service.env")}`,
		);
		expect(readRuntimeInstallReceipts(paths)?.companions.filebrowser).toMatchObject({
			desiredRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
			currentRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
		});

		const second = convergeRuntimeManifest(fileBrowserManifestLoad(manifest), paths, options);
		expect(second.installErrors).toEqual([]);
		expect(downloads).toBe(1);
		expect(activations).toBe(2);
		expect(authorityCommits).toBe(2);
		expect(readFileSync(active, "utf8")).toBe(binary);
	});

	test("rolls Files candidate, config, receipts, and systemd back on hash or readiness failure", () => {
		const paths = tempRuntimePaths();
		const originalBinary = "original Files binary\n";
		const originalManifest = fileBrowserManifest(paths, {
			generation: 1,
			binary: originalBinary,
		});
		const readyOptions = {
			fileBrowserInstallOptions: {
				serviceIsolation: testFileBrowserServiceIsolation,
				download: (_url: string, destination: string) => writeFileSync(destination, originalBinary),
				versionProbe: () => `${FILE_BROWSER_VERSION} ${FILE_BROWSER_COMMIT.slice(0, 7)}`,
			},
			fileBrowserReadinessProbe: () => true,
			systemdApply: fileBrowserApplyHooks(),
		};
		const initial = convergeRuntimeManifest(
			fileBrowserManifestLoad(originalManifest),
			paths,
			readyOptions,
		);
		expect(initial.installErrors).toEqual([]);
		const active = fileBrowserBinaryPath(paths, originalBinary);
		const originalConfig = readFileSync(paths.fileBrowserConfig, "utf8");
		const originalUnit = readFileSync(
			join(paths.systemdSystemRoot, "clawdi-files.service"),
			"utf8",
		);
		const originalReceipts = readFileSync(paths.installReceipts, "utf8");

		const desiredBinary = "desired Files binary\n";
		const hashFailureManifest = fileBrowserManifest(paths, {
			generation: 2,
			binary: desiredBinary,
		});
		let hashFailureCommits = 0;
		const hashFailure = convergeRuntimeManifest(
			fileBrowserManifestLoad(hashFailureManifest),
			paths,
			{
				...readyOptions,
				fileBrowserInstallOptions: {
					serviceIsolation: testFileBrowserServiceIsolation,
					download: (_url, destination) => writeFileSync(destination, "wrong digest\n"),
					versionProbe: () => `${FILE_BROWSER_VERSION} ${FILE_BROWSER_COMMIT.slice(0, 7)}`,
				},
				commitAuthority: () => hashFailureCommits++,
			},
		);
		expect(hashFailure.installErrors.join("\n")).toContain("Files companion SHA256 mismatch");
		expect(hashFailureCommits).toBe(0);
		expect(readFileSync(active, "utf8")).toBe(originalBinary);
		expect(existsSync(fileBrowserBinaryPath(paths, desiredBinary))).toBe(false);
		expect(readFileSync(paths.fileBrowserConfig, "utf8")).toBe(originalConfig);
		expect(readFileSync(join(paths.systemdSystemRoot, "clawdi-files.service"), "utf8")).toBe(
			originalUnit,
		);
		expect(readFileSync(paths.installReceipts, "utf8")).toBe(originalReceipts);

		const readinessManifest = fileBrowserManifest(paths, {
			generation: 3,
			binary: originalBinary,
			accessRevision: "b".repeat(64),
		});
		let readinessCommits = 0;
		let rollbacks = 0;
		const rollbackLifecycle: string[] = [];
		const readinessFailure = convergeRuntimeManifest(
			fileBrowserManifestLoad(readinessManifest),
			paths,
			{
				...readyOptions,
				fileBrowserReadinessProbe: () => false,
				systemdApply: fileBrowserApplyHooks({
					onQuiesce: () => {
						rollbackLifecycle.push("quiesce");
						expect(readFileSync(paths.fileBrowserConfig, "utf8")).not.toBe(originalConfig);
					},
					onRollback: () => {
						rollbackLifecycle.push("reconcile");
						expect(readFileSync(paths.fileBrowserConfig, "utf8")).toBe(originalConfig);
						rollbacks++;
					},
				}),
				commitAuthority: () => readinessCommits++,
			},
		);
		expect(readinessFailure.installErrors.join("\n")).toContain(
			"Files companion readiness failed at http://127.0.0.1:9120/health",
		);
		expect(readinessCommits).toBe(0);
		expect(rollbacks).toBe(1);
		expect(rollbackLifecycle).toEqual(["quiesce", "reconcile"]);
		expect(readFileSync(active, "utf8")).toBe(originalBinary);
		expect(readFileSync(paths.fileBrowserConfig, "utf8")).toBe(originalConfig);
		expect(readFileSync(join(paths.systemdSystemRoot, "clawdi-files.service"), "utf8")).toBe(
			originalUnit,
		);
		expect(readFileSync(paths.installReceipts, "utf8")).toBe(originalReceipts);
	});

	test("preserves candidate inputs when service quiesce fails", () => {
		const paths = tempRuntimePaths();
		const binary = "Files rollback ordering binary\n";
		const installOptions = {
			serviceIsolation: testFileBrowserServiceIsolation,
			download: (_url: string, destination: string) => writeFileSync(destination, binary),
			versionProbe: () => `${FILE_BROWSER_VERSION} ${FILE_BROWSER_COMMIT.slice(0, 7)}`,
		};
		const initial = convergeRuntimeManifest(
			fileBrowserManifestLoad(fileBrowserManifest(paths, { generation: 1, binary })),
			paths,
			{
				fileBrowserInstallOptions: installOptions,
				fileBrowserReadinessProbe: () => true,
				systemdApply: fileBrowserApplyHooks(),
			},
		);
		expect(initial.installErrors).toEqual([]);
		const originalConfig = readFileSync(paths.fileBrowserConfig, "utf8");
		const candidateEgressEnv = "CLAWDI_EGRESS_TRANSPARENT_PORT=27212\n";
		let candidateConfig: string | null = null;
		let reconciles = 0;

		const failed = convergeRuntimeManifest(
			fileBrowserManifestLoad(
				fileBrowserManifest(paths, {
					generation: 2,
					binary,
					accessRevision: "c".repeat(64),
				}),
			),
			paths,
			{
				fileBrowserInstallOptions: installOptions,
				fileBrowserReadinessProbe: () => true,
				systemdApply: fileBrowserApplyHooks({
					onActivate: () => {
						mkdirSync(dirname(paths.egressTransparentEnv), { recursive: true });
						writeFileSync(paths.egressTransparentEnv, candidateEgressEnv);
						throw new Error("injected candidate activation failure");
					},
					onQuiesce: () => {
						candidateConfig = readFileSync(paths.fileBrowserConfig, "utf8");
						throw new Error("injected candidate quiesce failure");
					},
					onRollback: () => reconciles++,
				}),
			},
		);

		expect(failed.installErrors.join("\n")).toContain("injected candidate activation failure");
		expect(failed.installErrors.join("\n")).toContain("injected candidate quiesce failure");
		expect(failed.installErrors).toContain(
			"runtime filesystem rollback skipped because candidate services did not quiesce",
		);
		expect(reconciles).toBe(0);
		expect(candidateConfig).not.toBeNull();
		if (candidateConfig === null) throw new Error("candidate Files config was not observed");
		expect(candidateConfig).not.toBe(originalConfig);
		expect(readFileSync(paths.fileBrowserConfig, "utf8")).toBe(candidateConfig);
		expect(readFileSync(paths.egressTransparentEnv, "utf8")).toBe(candidateEgressEnv);
	});

	test("retains only the desired Files candidate after authority commit", () => {
		const paths = tempRuntimePaths();
		const firstBinary = "first Files candidate\n";
		const secondBinary = "second Files candidate\n";
		const install = (manifest: RuntimeManifest, binary: string) =>
			convergeRuntimeManifest(fileBrowserManifestLoad(manifest), paths, {
				fileBrowserInstallOptions: {
					serviceIsolation: testFileBrowserServiceIsolation,
					download: (_url, destination) => writeFileSync(destination, binary),
					versionProbe: () => `${FILE_BROWSER_VERSION} ${FILE_BROWSER_COMMIT.slice(0, 7)}`,
				},
				fileBrowserReadinessProbe: () => true,
				systemdApply: fileBrowserApplyHooks(),
			});
		expect(
			install(fileBrowserManifest(paths, { generation: 1, binary: firstBinary }), firstBinary)
				.installErrors,
		).toEqual([]);
		const secondManifest = fileBrowserManifest(paths, { generation: 2, binary: secondBinary });
		expect(install(secondManifest, secondBinary).installErrors).toEqual([]);
		const firstTarget = dirname(fileBrowserBinaryPath(paths, firstBinary));
		const desiredTarget = dirname(fileBrowserBinaryPath(paths, secondBinary));
		const orphan = join(paths.fileBrowserInstallRoot, "candidates", "c".repeat(64));
		mkdirSync(orphan, { recursive: true });

		expect(gcFileBrowserCompanionCandidates(secondManifest, paths)).toEqual([orphan]);
		expect(existsSync(firstTarget)).toBe(false);
		expect(existsSync(desiredTarget)).toBe(true);
		expect(existsSync(orphan)).toBe(false);
	});

	test("withdraws only the Files system unit when the companion becomes ineligible", () => {
		const paths = tempRuntimePaths();
		const binary = "Files eligibility fixture\n";
		const manifest = fileBrowserManifest(paths, { generation: 1, binary });
		const installOptions = {
			fileBrowserInstallOptions: {
				serviceIsolation: testFileBrowserServiceIsolation,
				download: (_url: string, destination: string) => writeFileSync(destination, binary),
				versionProbe: () => `${FILE_BROWSER_VERSION} ${FILE_BROWSER_COMMIT.slice(0, 7)}`,
			},
			fileBrowserReadinessProbe: () => true,
			systemdApply: fileBrowserApplyHooks(),
		};
		expect(
			convergeRuntimeManifest(fileBrowserManifestLoad(manifest), paths, installOptions)
				.installErrors,
		).toEqual([]);

		const fileBrowserUnit = join(paths.systemdSystemRoot, "clawdi-files.service");
		const runtimeUnit = join(paths.systemdUserRoot, "openclaw-gateway.service");
		expect(existsSync(fileBrowserUnit)).toBe(true);
		expect(existsSync(runtimeUnit)).toBe(true);
		const withoutFileBrowser: RuntimeManifest = {
			...manifest,
			generation: 2,
			issuedAt: "2026-08-05T00:00:02.000Z",
			companions: {},
		};
		let staleSystemUnits: string[] = [];
		const result = convergeRuntimeManifest(fileBrowserManifestLoad(withoutFileBrowser), paths, {
			systemdApply: {
				quiesce: () => {},
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: (signal) => {
					staleSystemUnits = signal.staleSystemUnits;
					return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
				},
				rollback: () => {},
			},
		});

		expect(result.installErrors).toEqual([]);
		expect(staleSystemUnits).toEqual(["clawdi-files.service"]);
		expect(existsSync(fileBrowserUnit)).toBe(false);
		expect(existsSync(runtimeUnit)).toBe(true);
	});

	test("cleans interrupted Files staging directories without following symlinks", () => {
		const paths = tempRuntimePaths();
		const binary = "Files staging fixture\n";
		const manifest = fileBrowserManifest(paths, { generation: 1, binary });
		const options = {
			fileBrowserInstallOptions: {
				serviceIsolation: testFileBrowserServiceIsolation,
				download: (_url: string, destination: string) => writeFileSync(destination, binary),
				versionProbe: () => `${FILE_BROWSER_VERSION} ${FILE_BROWSER_COMMIT.slice(0, 7)}`,
			},
			fileBrowserReadinessProbe: () => true,
			systemdApply: fileBrowserApplyHooks(),
		};
		expect(
			convergeRuntimeManifest(fileBrowserManifestLoad(manifest), paths, options).installErrors,
		).toEqual([]);

		const candidates = join(paths.fileBrowserInstallRoot, "candidates");
		const interrupted = join(candidates, ".staging-interrupted");
		mkdirSync(interrupted);
		expect(
			convergeRuntimeManifest(fileBrowserManifestLoad(manifest), paths, options).installErrors,
		).toEqual([]);
		expect(existsSync(interrupted)).toBe(false);

		const outside = join(dirname(paths.fileBrowserInstallRoot), "outside-staging-target");
		mkdirSync(outside);
		const unsafe = join(candidates, ".staging-unsafe");
		symlinkSync(outside, unsafe);
		const refused = convergeRuntimeManifest(fileBrowserManifestLoad(manifest), paths, options);
		expect(refused.installErrors.join("\n")).toContain(
			"Files companion staging entry is not a trusted directory",
		);
		expect(existsSync(outside)).toBe(true);
	});

	test('treats a user runtime named "files" as a normal runtime program', () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(paths, {
			files: {
				enabled: true,
				run: runSettings(process.execPath, ["--version"]),
				services: {},
			},
		});
		const result = convergeRuntimeManifest(manifestLoad(manifest, "runtime-named-files"), paths);

		expect(result.installErrors).toEqual([]);
		expect(result.outputs.systemdSystemUnits).not.toContain(
			join(paths.systemdSystemRoot, "clawdi-files.service"),
		);
		expect(result.outputs.systemdUserUnits).toContain(
			join(paths.systemdUserRoot, "clawdi-files.service"),
		);
	});

	test("enforces pinned and internally bound Files contracts", () => {
		const paths = tempRuntimePaths();
		const binary = "Files gate fixture\n";
		const manifest = fileBrowserManifest(paths, { generation: 1, binary });
		expect(() => convergeRuntimeManifest(fileBrowserManifestLoad(manifest), paths)).toThrow(
			"Files companion requires systemd apply and readiness hooks",
		);
		expect(existsSync(paths.fileBrowserInstallRoot)).toBe(false);
		expect(existsSync(join(paths.systemdSystemRoot, "clawdi-files.service"))).toBe(false);

		const pinned = fileBrowserCompanion();
		expect(fileBrowserCompanionSchema.safeParse(pinned).success).toBe(true);
		expect(manifest.deploymentId).not.toBe("hdep_files_reconcile");
		for (const [field, value] of [
			["audience", "clawdi-files:hdep_other"],
			["subject", "deployment:hdep_other:owner"],
			["requiredGroup", `clawdi-files:hdep_files_reconcile:${"b".repeat(64)}`],
		] as const) {
			expect(
				fileBrowserCompanionSchema.safeParse({
					...pinned,
					auth: { ...pinned.auth, [field]: value },
				}).success,
			).toBe(false);
		}
		expect(
			hostedRuntimeBundleV2ManifestSchema.safeParse({
				...manifest,
				companions: { files: pinned },
			}).success,
		).toBe(false);
		expect(fileBrowserCompanionSchema.safeParse({ ...pinned, kind: "filebrowser" }).success).toBe(
			false,
		);
		expect(fileBrowserCompanionSchema.safeParse({ ...pinned, port: 9000 }).success).toBe(false);
		const nextRelease = {
			...pinned,
			version: "v1.6.0-stable",
			commit: "b".repeat(40),
			assets: {
				amd64: {
					url: "https://github.com/gtsteffaniak/filebrowser/releases/download/v1.6.0-stable/linux-amd64-filebrowser",
					sha256: "c".repeat(64),
				},
				arm64: {
					url: "https://github.com/gtsteffaniak/filebrowser/releases/download/v1.6.0-stable/linux-arm64-filebrowser",
					sha256: "d".repeat(64),
				},
			},
		};
		expect(fileBrowserCompanionSchema.safeParse(nextRelease).success).toBe(true);
		expect(
			fileBrowserCompanionSchema.safeParse({
				...pinned,
				listen: "127.0.0.1",
			}).success,
		).toBe(false);
		expect(
			fileBrowserCompanionSchema.safeParse({
				...pinned,
				assets: {
					...pinned.assets,
					amd64: {
						...pinned.assets.amd64,
						url: "https://github.com/gtsteffaniak/filebrowser/releases/download/v1.6.0-stable/linux-amd64-filebrowser",
					},
				},
			}).success,
		).toBe(false);
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

	test("fails closed when a platform root disappears before a later mutation group", () => {
		const paths = tempRuntimePaths();
		const manifest = baseManifest(paths, {
			openclaw: { enabled: false, services: {} },
			hermes: { enabled: false, services: {} },
		});
		const result = convergeRuntimeManifest(manifestLoad(manifest, "missing-late-run-root"), paths, {
			cacheLastGood: false,
			systemdApply: {
				quiesce: () => {},
				activateEgressPrerequisite: successfulPrerequisiteActivation,
				activate: () => {
					rmSync(paths.runRoot, { recursive: true });
					return successfulPrerequisiteActivation();
				},
				rollback: () => {},
			},
		});

		expect(result.installErrors.join("\n")).toContain(
			`platform directory is missing: ${paths.runRoot}`,
		);
		expect(existsSync(paths.runRoot)).toBe(false);
	});
});
