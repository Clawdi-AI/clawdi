import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildAgentTargetProjection } from "../lib/ai-provider-projection";
import {
	type FileBrowserCompanionInstallOptions,
	fileBrowserCompanionProgram,
} from "./file-browser-companion";
import type { HermesConfigTransaction } from "./hermes-config";
import type { PreparedHostedAgentPlugins } from "./hosted-agent-plugin-package";
import {
	type HostedAgentPluginCommandRunner,
	type HostedAgentPluginCommands,
	type HostedAgentPluginTransaction,
	prepareHostedAgentPluginTransaction,
} from "./hosted-agent-plugin-runtime";
import {
	agentTargetProjectionInput,
	hostedAiProviderCatalog,
	hostedProviderEnvironment,
} from "./hosted-provider-resolution";
import type { HostedRuntimeContractOptions } from "./hosted-runtime-contract";
import type { PreparedHostedSkill } from "./hosted-sourced-skill-archive";
import type { ManagedBaileysRuntime } from "./managed-baileys-compat";
import { buildHermesManagedChannelsPatch } from "./managed-channel-reconciliation";
import {
	hostedChannelProjection,
	hostedWhatsAppAuthCredentials,
	openClawManagedChannelsPatch,
	validateHostedChannelCredentialsPlan,
} from "./manifest-channels";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeInstallObservation } from "./manifest-install";
import { validateHostedMcpProjectionPlan } from "./manifest-mcp";
import {
	assertHostedProviderProjectionMode,
	buildOpenClawHostedProviderPatch,
	hostedCodexManagedConfigToml,
	hostedCodexManagedProvider,
	openClawGatewayHostedPatch,
} from "./manifest-providers";
import {
	managedLocaleBlock,
	mergeRuntimeSecretEnv,
	nextManagedLocaleFileContent,
	resolvedRuntimeServiceSettings,
	resolvedRuntimeSettings,
} from "./manifest-runtime-config";
import { scopedSecretValues } from "./manifest-secrets";
import {
	type RuntimeConvergenceResult,
	type RuntimePrivateAppliedAuthority,
	type RuntimeSystemdApplyHooks,
	recordValue,
} from "./manifest-shared";
import type { RuntimeManifestLoad } from "./manifest-source";
import type { EnsureRuntimeMitmproxyOptions } from "./mitmproxy-fetch";
import type { RuntimePaths } from "./paths";
import { hostedRuntimeProjectionHome } from "./projection-home";
import {
	buildRuntimeRunConfig,
	isSupportedRuntimeName,
	type RuntimeRunConfig,
	runtimeNameSchema,
	runtimeServiceNameSchema,
} from "./run-config";
import {
	buildRuntimeSystemdUserProgram,
	type RuntimeEgressSystemdProgram,
	type RuntimeSystemdUserProgram,
} from "./runtime-systemd-reconciliation";

export interface RuntimeConvergenceOptions {
	cacheLastGood?: boolean;
	commitAuthority?: (
		convergence: RuntimeConvergenceResult,
		authority: RuntimePrivateAppliedAuthority,
	) => void;
	egressEngineEnsureOptions?: EnsureRuntimeMitmproxyOptions;
	systemdApply?: RuntimeSystemdApplyHooks;
	executeOfficialServiceInstallers?: boolean;
	fileBrowserInstallOptions?: FileBrowserCompanionInstallOptions;
	fileBrowserReadinessProbe?: (url: string) => boolean;
	preparedHostedSourcedSkills?: ReadonlyMap<string, PreparedHostedSkill>;
	preparedHostedAgentPlugins?: PreparedHostedAgentPlugins;
	resourcePreparationFailures?: RuntimeResourcePreparationFailures;
	hostedAgentPluginCommandRunner?: HostedAgentPluginCommandRunner;
	hostedRuntimeContract?: HostedRuntimeContractOptions;
}

export interface RuntimeResourcePreparationFailures {
	agentPlugins?: {
		error: string;
		installationNames: readonly string[];
	};
	sourcedSkills?: string;
}
export function planHostedAgentPluginConvergence(input: {
	prepared: PreparedHostedAgentPlugins;
	home: string;
	commands: HostedAgentPluginCommands;
	runner?: HostedAgentPluginCommandRunner;
}): {
	transaction: HostedAgentPluginTransaction | null;
} {
	return {
		transaction: prepareHostedAgentPluginTransaction({
			prepared: input.prepared,
			home: input.home,
			commands: input.commands,
			...(input.runner ? { runner: input.runner } : {}),
		}),
	};
}
export function runtimeWorkspaceRoot(manifest: RuntimeManifest, paths: RuntimePaths): string {
	return manifest.workspaceRoot ?? paths.workspaceRoot;
}
export function runtimeSecretValues(load: RuntimeManifestLoad): Record<string, string> | undefined {
	return load.secretValues && Object.keys(load.secretValues).length > 0
		? load.secretValues
		: undefined;
}
export function planRuntimeSystemdUserPrograms(input: {
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	workspaceRoot: string;
	generatedAt: string;
	secretValues: Record<string, string> | undefined;
	observations: Map<string, RuntimeInstallObservation>;
	egressProfileBundlePath: string | null;
	egress: RuntimeEgressSystemdProgram | null;
}): RuntimeSystemdUserProgram[] {
	const programs: RuntimeSystemdUserProgram[] = [];
	for (const [name, runtime] of Object.entries(input.manifest.runtimes).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const observation = input.observations.get(name);
		if (!observation) throw new Error(`runtime ${name} install observation is missing`);
		const resolved = resolveRuntimeRunConfigs({
			manifest: input.manifest,
			paths: input.paths,
			name,
			runtime,
			observation,
			workspaceRoot: input.workspaceRoot,
			generatedAt: input.generatedAt,
			secretValues: input.secretValues,
			egressProfileBundlePath: input.egressProfileBundlePath,
		});
		if (
			runtime.enabled &&
			(isSupportedRuntimeName(name) || Boolean(runtime.run?.command?.trim()))
		) {
			const program = buildRuntimeSystemdUserProgram({
				config: resolved.runtime,
				paths: input.paths,
				secretValues: input.secretValues,
				egress: input.egress,
			});
			if (program) programs.push(program);
		}
		for (const serviceRunConfig of resolved.services) {
			const program = buildRuntimeSystemdUserProgram({
				config: serviceRunConfig,
				paths: input.paths,
				secretValues: input.secretValues,
				egress: input.egress,
			});
			if (program) programs.push(program);
		}
	}
	const fileBrowserProgram = fileBrowserCompanionProgram(input.manifest, input.paths);
	if (fileBrowserProgram) programs.push(fileBrowserProgram);
	return programs;
}
interface ResolvedRuntimeRunConfigs {
	runtime: RuntimeRunConfig;
	services: RuntimeRunConfig[];
	secretEnv: Record<string, string>;
	secretFilePath: string | null;
}
export function resolveRuntimeRunConfigs(input: {
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	name: string;
	runtime: RuntimeManifest["runtimes"][string];
	observation: RuntimeInstallObservation;
	workspaceRoot: string;
	generatedAt: string;
	secretValues: Record<string, string> | undefined;
	egressProfileBundlePath: string | null;
}): ResolvedRuntimeRunConfigs {
	const runtimeName = runtimeNameSchema.parse(input.name);
	const providerEnvironment = input.runtime.enabled
		? hostedProviderEnvironment(input.manifest, input.name, { validateOverlap: true })
		: { placeholderEnv: {}, secretEnv: {} };
	const { placeholderEnv: providerPlaceholderEnv, secretEnv: providerSecretEnv } =
		providerEnvironment;
	const runtimeRunSettings = resolvedRuntimeSettings(
		runtimeName,
		input.runtime.run,
		providerPlaceholderEnv,
	);
	const secretEnv = input.runtime.enabled
		? mergeRuntimeSecretEnv(input.name, runtimeRunSettings, providerSecretEnv)
		: {};
	scopedSecretValues(input.secretValues, Object.values(secretEnv));
	const secretFilePath = null;
	const runtime = buildRuntimeRunConfig({
		runtime: runtimeName,
		enabled: input.runtime.enabled,
		generatedAt: input.generatedAt,
		generation: input.manifest.generation,
		instanceId: input.manifest.instanceId,
		commandPath: input.observation.commandPath,
		appRoot: input.observation.appRoot,
		workspaceRoot: input.workspaceRoot,
		egressProfileBundlePath: input.egressProfileBundlePath,
		settings: runtimeRunSettings,
		secretFilePath,
		secretEnv,
	});
	const services = Object.entries(input.runtime.services ?? {})
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([serviceName, serviceSettings]) => {
			const service = runtimeServiceNameSchema.parse(serviceName);
			const settings = resolvedRuntimeServiceSettings(
				input.manifest,
				runtimeName,
				service,
				serviceSettings,
				providerPlaceholderEnv,
			);
			return buildRuntimeRunConfig({
				runtime: runtimeName,
				service,
				enabled: input.runtime.enabled,
				generatedAt: input.generatedAt,
				generation: input.manifest.generation,
				instanceId: input.manifest.instanceId,
				commandPath: input.observation.commandPath,
				appRoot: input.observation.appRoot,
				workspaceRoot: input.workspaceRoot,
				settings,
				secretFilePath: null,
				secretEnv: input.runtime.enabled
					? mergeRuntimeSecretEnv(input.name, settings, providerSecretEnv, service)
					: {},
			});
		});
	return { runtime, services, secretEnv, secretFilePath };
}
export function runtimeConvergenceWithoutApply(input: {
	load: RuntimeManifestLoad;
	paths: RuntimePaths;
	workspaceRoot: string;
	enabledRuntimes: string[];
	installErrors: string[];
	projectedProviderIds: Record<string, string[]>;
	agentPluginFailedNames?: string[];
}): RuntimeConvergenceResult {
	return {
		manifest: input.load.manifest,
		source: input.load.source,
		sourcePath: input.load.sourcePath,
		offline: input.load.offline,
		mode: input.load.offline ? "degraded-offline" : "normal",
		enabledRuntimes: input.enabledRuntimes,
		installErrors: input.installErrors,
		resourceProjectionErrors: [],
		projectedProviderIds: input.projectedProviderIds,
		agentPluginFailedNames: input.agentPluginFailedNames ?? [],
		outputs: {
			processManager: "systemd",
			workspaceRoot: input.workspaceRoot,
			manifestLastGood: null,
			appliedState: null,
			managedLocaleFiles: [],
			runConfigs: [],
			systemdSystemUnitRoot: input.paths.systemdSystemRoot,
			systemdSystemUnits: [],
			systemdUserUnitRoot: input.paths.systemdUserRoot,
			systemdUserUnits: [],
			egressProfileBundle: null,
			egressSecretFile: null,
			egressEngine: null,
			egressTransparentEnv: null,
			egressAddon: null,
			liveSyncEnvironments: [],
			daemonAuthTokenFile: null,
		},
	};
}
export function validateRuntimeProjectionPlan(input: {
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	openClawWorkspaceRoot: string | null;
	secretValues: Record<string, string> | undefined;
	observations: Map<string, RuntimeInstallObservation>;
	previousProjectedProviderIds: Record<string, string[]>;
	hermesWhatsAppAuthDir: string | null;
	hermesConfig: HermesConfigTransaction | null;
	openClawOwnerBrowserBootstrapSupported: boolean;
}): void {
	const {
		manifest,
		paths,
		openClawWorkspaceRoot,
		secretValues,
		observations,
		previousProjectedProviderIds,
		hermesWhatsAppAuthDir,
		hermesConfig,
		openClawOwnerBrowserBootstrapSupported,
	} = input;
	const home = hostedRuntimeProjectionHome(manifest, paths);
	const localeBlock = manifest.locale ? managedLocaleBlock(manifest.locale) : null;
	if (localeBlock) {
		for (const name of Object.keys(manifest.runtimes)) {
			if (manifest.runtimes[name]?.enabled !== true) continue;
			if (name === "openclaw") {
				if (!openClawWorkspaceRoot)
					throw new Error("OpenClaw official agent workspace is unavailable");
				nextManagedLocaleFileContent(join(openClawWorkspaceRoot, "SOUL.md"), localeBlock);
			}
			if (name === "hermes") {
				nextManagedLocaleFileContent(join(home, ".hermes", "SOUL.md"), localeBlock);
			}
		}
	}

	const codexProvider = hostedCodexManagedProvider(manifest);
	if (codexProvider) {
		hostedCodexManagedConfigToml(codexProvider);
	}

	for (const [name, runtime] of Object.entries(manifest.runtimes).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const projectionInput = agentTargetProjectionInput(hostedAiProviderCatalog(manifest, name));
		assertHostedProviderProjectionMode(name, manifest, projectionInput);
		const configuredProjectionUnavailable =
			manifest.runtimes[name]?.providerMode === "configured" && !projectionInput;
		if (name === "openclaw") {
			if (projectionInput) {
				buildOpenClawHostedProviderPatch(
					projectionInput,
					previousProjectedProviderIds.openclaw ?? [],
				);
			} else if (!configuredProjectionUnavailable) {
				buildOpenClawHostedProviderPatch(null, previousProjectedProviderIds.openclaw ?? []);
			}
			JSON.stringify(
				openClawGatewayHostedPatch(manifest, secretValues, openClawOwnerBrowserBootstrapSupported),
			);
		}
		if (name === "hermes") {
			if (projectionInput) {
				const yamlProjection = buildAgentTargetProjection(
					"hermes",
					projectionInput.catalog,
					projectionInput.primaryModel,
					{ freezeManagedModelCatalog: true },
				);
				const yamlFile = yamlProjection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
				if (!yamlFile)
					throw new Error("Hermes projection did not include a config merge YAML file.");
				if (!recordValue(parseYaml(yamlFile.content) as unknown)) {
					throw new Error("Hermes projection patch must be a YAML object.");
				}
			}
		}

		const channels = hostedChannelProjection(manifest);
		if (channels && name === "openclaw") JSON.stringify(openClawManagedChannelsPatch(channels));
		if (channels && name === "hermes" && runtime.enabled) {
			buildHermesManagedChannelsPatch(channels, hermesWhatsAppAuthDir);
		}
	}
	validateHostedMcpProjectionPlan(manifest, paths, observations, hermesConfig);
	validateHostedChannelCredentialsPlan(manifest, secretValues, home);
}
export function managedWhatsAppCompatibilityRuntime(
	manifest: RuntimeManifest,
): ManagedBaileysRuntime | null {
	const runtimes = new Set<ManagedBaileysRuntime>();
	for (const credential of hostedWhatsAppAuthCredentials(manifest)) {
		runtimes.add(credential.target);
	}
	if (runtimes.size > 1) {
		throw new Error("managed WhatsApp projection must target exactly one native runtime");
	}
	return runtimes.values().next().value ?? null;
}
