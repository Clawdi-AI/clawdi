import { parse as parseYaml } from "yaml";
import { buildAgentTargetProjection } from "../lib/ai-provider-projection";
import {
	applyHostedHermesAiProviderProjection,
	buildOpenClawHostedProviderPatch,
	type CatalogProviderConfigurationResult,
	providerProjectionProgramImpact,
} from "./catalog-provider-config";
import type { HermesConfigTransaction } from "./hermes-config";
import { applyHermesNativeProviders } from "./hermes-native-provider";
import type { OpenClawHostedContext } from "./hosted-openclaw-context";
import {
	hostedProviderConfiguration,
	hostedProviderEnvironment,
	hostedProviderRequiresApiKey,
} from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeInstallObservation } from "./manifest-install";
import { removeOpenClawManagedProviderAuthProfiles } from "./manifest-oauth";
import { recordValue, stringValue } from "./manifest-shared";
import {
	applyOpenClawNativeProviders,
	buildNativeOpenClawProviderPatch,
	discoverNativeOpenClawProviderIds,
	ensureNativeOpenClawProviderPlugins,
} from "./openclaw-native-provider";
import {
	applyOpenClawGatewayHostedProjection,
	applyOpenClawHostedProviderPatch,
} from "./openclaw-provider-config";
import { runtimeImpactRevision } from "./runtime-impact-revision";
import { runtimeSecretValue } from "./secret-values";

export { buildOpenClawHostedProviderPatch } from "./catalog-provider-config";
export {
	applyHostedCodexManagedProviderProjection,
	CODEX_MANAGED_PROVIDER_CONFIG_FILE,
	ensureHostedCodexCli,
	hostedCodexHome,
	hostedCodexManagedConfigToml,
	hostedCodexManagedProvider,
} from "./managed-codex-provider";
export {
	type OpenClawHostedProviderPatch,
	openClawConfigPatchIsApplied,
	openClawGatewayHostedPatch,
} from "./openclaw-provider-config";

interface HostedAiProviderProjectionResult extends CatalogProviderConfigurationResult {
	nativeCredentialsChanged?: boolean;
	nativeCredentialProviderIds?: string[];
}

export function applyHostedAiProviderProjection(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	home: string,
	openClawContext: OpenClawHostedContext,
	workspaceRoot: string,
	previousProviderIds: readonly string[],
	openClawOwnerBrowserBootstrapSupported: boolean,
	hermesConfig: HermesConfigTransaction | null,
	providerRevision: string,
	previousNativeProviderIds: readonly string[] = [],
): HostedAiProviderProjectionResult {
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath)
		return { path: null, revision: null, providerIds: [] };
	const { native, catalog } = hostedProviderConfiguration(manifest, name);
	if (manifest.runtimes[name]?.providerMode === "configured" && !catalog && native.length === 0) {
		if (name === "openclaw")
			applyOpenClawGatewayHostedProjection(
				observation.commandPath,
				manifest,
				secretValues,
				openClawContext,
				workspaceRoot,
				openClawOwnerBrowserBootstrapSupported,
			);
		return {
			path: null,
			revision: null,
			providerIds: [...previousProviderIds],
			nativeCredentialProviderIds: [...previousNativeProviderIds],
		};
	}
	if (name === "hermes") {
		if (!hermesConfig) throw new Error("Hermes config command is unavailable");
		const auth = applyHermesNativeProviders({
			connections: native,
			previousProviderIds: previousNativeProviderIds,
			secretValues: secretValues ?? {},
			config: hermesConfig,
			home,
			workspaceRoot,
		});
		const projection = applyHostedHermesAiProviderProjection(
			catalog,
			previousProviderIds,
			home,
			hermesConfig,
			true,
			native.length > 0,
		);
		return {
			...projection,
			nativeCredentialsChanged: auth.changed,
			nativeCredentialProviderIds: auth.providerIds,
		};
	}
	if (name !== "openclaw") return { path: null, revision: null, providerIds: [] };
	const patch = buildOpenClawHostedProviderPatch(
		catalog,
		previousProviderIds,
		native.length > 0 ? "merge" : "replace",
	);
	const { placeholderEnv, configEnv, secretEnv } = hostedProviderEnvironment(manifest, name);
	const environment = { ...placeholderEnv, ...configEnv };
	for (const [key, ref] of Object.entries(secretEnv)) {
		const value = runtimeSecretValue(secretValues ?? {}, ref);
		if (!value) throw new Error("OpenClaw provider credential is unavailable");
		environment[key] = value;
	}
	let nativeChanged = ensureNativeOpenClawProviderPlugins(
		native,
		observation.commandPath,
		openClawContext.home,
		workspaceRoot,
		environment,
	);
	applyOpenClawGatewayHostedProjection(
		observation.commandPath,
		manifest,
		secretValues,
		openClawContext,
		workspaceRoot,
		openClawOwnerBrowserBootstrapSupported,
		environment,
	);
	// The catalog SDK owns exact replacement and large shrink. It runs first so
	// migration from a whole-owned catalog row to native auth cannot retain models.
	if (patch.apply)
		applyOpenClawHostedProviderPatch(
			patch,
			observation.commandPath,
			openClawContext,
			workspaceRoot,
			providerRevision,
		);
	const ownedNativeProviderIds = [
		...new Set([
			...previousNativeProviderIds,
			...discoverNativeOpenClawProviderIds(
				observation.commandPath,
				openClawContext,
				workspaceRoot,
				environment,
			),
		]),
	];
	const nativePatch = buildNativeOpenClawProviderPatch(
		native,
		ownedNativeProviderIds.filter(
			(id) => !patch.providerIds.includes(id) && !previousProviderIds.includes(id),
		),
	);
	if (native.length > 0 || ownedNativeProviderIds.length > 0) {
		nativeChanged =
			applyOpenClawNativeProviders({
				patch: nativePatch,
				command: observation.commandPath,
				context: openClawContext,
				workspaceRoot,
				environment,
			}) || nativeChanged;
	}
	if (openClawContext.managedApiKeyProjection) {
		if (openClawContext.agentDirs.managed.length === 0)
			throw new Error("OpenClaw managed provider-auth stores were not transactionally discovered");
		removeOpenClawManagedProviderAuthProfiles(openClawContext, workspaceRoot, providerRevision);
	}
	return {
		path: observation.commandPath,
		revision: null,
		providerIds: patch.providerIds,
		nativeCredentialProviderIds: nativePatch.providerIds,
		nativeCredentialsChanged: nativeChanged,
	};
}

export function previewHostedAiProviderProjectionRevision(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	home: string,
	previousProviderIds: readonly string[],
	previousNativeProviderIds: readonly string[] = [],
): string | null {
	if (
		(name !== "openclaw" && name !== "hermes") ||
		!observation.enabled ||
		observation.status === "install_failed" ||
		!observation.commandPath
	)
		return null;
	const { native, catalog } = hostedProviderConfiguration(manifest, name);
	if (manifest.runtimes[name]?.providerMode === "configured" && !catalog && native.length === 0)
		return null;
	if (name === "hermes")
		return applyHostedHermesAiProviderProjection(
			catalog,
			previousProviderIds,
			home,
			null,
			false,
			native.length > 0,
		).revision;
	const patch = buildOpenClawHostedProviderPatch(
		catalog,
		previousProviderIds,
		native.length > 0 ? "merge" : "replace",
	);
	return runtimeImpactRevision({
		catalog: providerProjectionProgramImpact("openclaw", JSON.parse(patch.content), catalog),
		native: buildNativeOpenClawProviderPatch(
			native,
			previousNativeProviderIds.filter(
				(id) => !patch.providerIds.includes(id) && !previousProviderIds.includes(id),
			),
		).config,
	});
}

/** Validate the selected path without materializing any credentials. */
export function validateHostedProviderConfiguration(
	manifest: RuntimeManifest,
	name: string,
	previousProviderIds: readonly string[],
): void {
	const { native, catalog } = hostedProviderConfiguration(manifest, name);
	if (name === "openclaw") {
		buildOpenClawHostedProviderPatch(
			catalog,
			previousProviderIds,
			native.length > 0 ? "merge" : "replace",
		);
		if (native.length > 0) buildNativeOpenClawProviderPatch(native, []);
	} else if (name === "hermes" && catalog) {
		const projection = buildAgentTargetProjection("hermes", catalog.catalog, catalog.primaryModel, {
			freezeManagedModelCatalog: true,
		});
		const file = projection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
		if (!file || !recordValue(parseYaml(file.content)))
			throw new Error("Hermes provider projection must be a YAML object");
	}
}

export function providerHealthReasons(
	provider: Record<string, unknown>,
	secretAvailable: boolean | null,
): string[] {
	const reasons: string[] = [];
	const status = stringValue(provider.status);
	if (status && status !== "ok") {
		reasons.push(`provider_${status}`);
	}
	const error = recordValue(provider.error);
	const errorCode = error ? stringValue(error.code) : null;
	if (errorCode) {
		reasons.push(errorCode);
	}
	const baseUrl = stringValue(provider.baseUrl);
	if (!baseUrl) {
		reasons.push("base_url_missing");
	} else {
		try {
			new URL(baseUrl);
		} catch {
			reasons.push("base_url_invalid");
		}
	}
	if (
		provider.configurationMode !== "native" &&
		!stringValue(provider.model) &&
		!providerHasModels(provider)
	) {
		reasons.push("model_missing");
	}
	const apiMode = stringValue(provider.apiMode);
	if (baseUrl && isOpenAiCompatibleMode(apiMode)) {
		try {
			const parsed = new URL(baseUrl);
			if (!parsed.pathname || parsed.pathname === "/") {
				reasons.push("base_url_path_missing");
			}
		} catch {
			// Already reported as base_url_invalid above.
		}
	}
	if (stringValue(provider.apiKeySecretRef) && secretAvailable === false) {
		reasons.push("secret_missing");
	}
	if (hostedProviderRequiresApiKey(provider) && !stringValue(provider.apiKeySecretRef)) {
		reasons.push("api_key_secret_ref_missing");
	}
	return reasons;
}
function providerHasModels(provider: Record<string, unknown>): boolean {
	return (
		Array.isArray(provider.models) &&
		provider.models.some((model) => {
			const entry = recordValue(model);
			return Boolean(entry && stringValue(entry.id));
		})
	);
}
function isOpenAiCompatibleMode(apiMode: string | null): boolean {
	return apiMode === "openai_chat" || apiMode === "openai_responses";
}
