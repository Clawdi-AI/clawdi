import { join } from "node:path";
import {
	CLAWDI_MANAGED_PROVIDER_ID,
	isClawdiManagedV2ProviderId,
	MANAGED_AI_PROVIDER_RUNTIME_ENV,
} from "@clawdi/shared";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../lib/codex-oauth-native-store";
import { agentTargetProjectionInput, hostedAiProviderCatalog } from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import { runtimeUserDirectoryOwnership } from "./runtime-user-command";

export const CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID = "clawdi-managed-provider";

export type OpenClawHostedContext = ReturnType<typeof createOpenClawHostedContext>;

function resolveSdkExports(
	home: string,
	location: { commandPath?: string | null; appRoot?: string | null } = {},
) {
	const startPaths = [location.commandPath, location.appRoot];
	const resolve = (path: Parameters<typeof resolveOpenClawSdkExport>[2]) =>
		resolveOpenClawSdkExport(home, startPaths, path);
	const testOverride = (name: "PROVIDER_AUTH" | "PROVIDER_ENV_VARS") => {
		const variable = `CLAWDI_RUNTIME_TEST_OPENCLAW_${name}_SDK`;
		const value = process.env[variable]?.trim();
		if (value && process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS !== "1") {
			throw new Error(`${variable} requires CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1`);
		}
		return value || null;
	};
	return {
		configMutation: resolve(OPENCLAW_SDK_EXPORT_PATHS.configMutation),
		deviceBootstrap: resolve(OPENCLAW_SDK_EXPORT_PATHS.deviceBootstrap),
		providerAuth: testOverride("PROVIDER_AUTH") ?? resolve(OPENCLAW_SDK_EXPORT_PATHS.providerAuth),
		providerEnvVars:
			testOverride("PROVIDER_ENV_VARS") ?? resolve(OPENCLAW_SDK_EXPORT_PATHS.providerEnvVars),
	};
}

export function createOpenClawHostedContext(manifest: RuntimeManifest, home: string) {
	const stateRoot = join(home, ".openclaw");
	const statePath = (...parts: string[]) => join(stateRoot, ...parts);
	const configPath = statePath("openclaw.json");
	const database = statePath("state", "openclaw.sqlite");
	const sourceDir = statePath("managed-sources", CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID);
	const installDir = statePath("extensions", CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID);
	const sdk = resolveSdkExports(home);
	const ownership =
		manifest.projection?.sourceBundleVersion === "clawdi.hosted-runtime.bundle.v2" &&
		manifest.runtimes.openclaw?.enabled === true
			? [
					...runtimeUserDirectoryOwnership(home),
					...runtimeUserDirectoryOwnership(stateRoot, { mode: 0o700 }),
					...runtimeUserDirectoryOwnership(statePath("tmp"), { mode: 0o700 }),
				]
			: [];
	return {
		home,
		managedApiKeyProjection: hasManagedApiKeyProjection(manifest),
		stateRoot,
		configPath,
		ownership,
		agentDirs: {
			main: statePath("agents", "main", "agent"),
			managed: [] as string[],
		},
		providerPlugin: {
			sourceDir,
			installDir,
			mutationTargets: [
				configPath,
				sourceDir,
				installDir,
				...["", "-wal", "-shm"].map((suffix) => database + suffix),
			],
		},
		sdk,
		requireSdkExport(name: keyof typeof sdk): string {
			const path = sdk[name];
			if (path) return path;
			const exportName = OPENCLAW_SDK_EXPORT_PATHS[name];
			throw new Error(`installed OpenClaw ${exportName} SDK export is unavailable`);
		},
		refreshSdkExports(location: { commandPath?: string | null; appRoot?: string | null }): void {
			Object.assign(sdk, resolveSdkExports(home, location));
		},
	};
}

function hasManagedApiKeyProjection(manifest: RuntimeManifest): boolean {
	const runtime = manifest.runtimes.openclaw;
	const sourceProviderId = runtime?.provider_ids?.[0];
	if (!sourceProviderId || !isClawdiManagedV2ProviderId(sourceProviderId)) return false;
	const sourceProvider = recordValue(manifest.projection?.providers?.[sourceProviderId]);
	const projectionInput = agentTargetProjectionInput(hostedAiProviderCatalog(manifest, "openclaw"));
	const provider = projectionInput?.catalog.providers.find(
		(entry) => entry.id === CLAWDI_MANAGED_PROVIDER_ID,
	);
	return (
		manifest.projection?.sourceBundleVersion === "clawdi.hosted-runtime.bundle.v2" &&
		runtime?.enabled === true &&
		runtime.providerMode === "configured" &&
		sourceProvider?.managed_by === "clawdi" &&
		typeof sourceProvider.apiKeySecretRef === "string" &&
		provider?.managed_by === "clawdi" &&
		provider.runtime_env_name === MANAGED_AI_PROVIDER_RUNTIME_ENV &&
		provider.auth.type === "api_key" &&
		provider.auth.source === "managed"
	);
}

function recordValue(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}
