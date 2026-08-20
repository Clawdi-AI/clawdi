import { join } from "node:path";
import {
	CLAWDI_MANAGED_PROVIDER_ID,
	isClawdiManagedV2ProviderId,
	MANAGED_AI_PROVIDER_RUNTIME_ENV,
} from "@clawdi/shared";
import {
	resolveOpenClawConfigMutationSdkExport,
	resolveOpenClawDeviceBootstrapSdkExport,
	resolveOpenClawProviderAuthSdkExport,
	resolveOpenClawProviderEnvVarsSdkExport,
} from "../lib/codex-oauth-native-store";
import { agentTargetProjectionInput, hostedAiProviderCatalog } from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeUserOwnershipRule } from "./runtime-user-command";

export const CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID = "clawdi-managed-provider";

export type OpenClawSdkExport =
	| "config-mutation"
	| "device-bootstrap"
	| "provider-auth"
	| "provider-env-vars";

export interface OpenClawRuntimeLocation {
	commandPath?: string | null;
	appRoot?: string | null;
}

export interface OpenClawHostedContext {
	home: string;
	hostedV2: boolean;
	enabled: boolean;
	managedApiKeyProjection: boolean;
	stateRoot: string;
	configPath: string;
	tmpDir: string;
	ownership: RuntimeUserOwnershipRule[];
	agentDirs: {
		root: string;
		main: string;
		managed: string[];
	};
	providerPlugin: {
		sourceDir: string;
		installDir: string;
		mutationTargets: string[];
	};
	resolveSdkExport(exportName: OpenClawSdkExport, location: OpenClawRuntimeLocation): string | null;
}

export function createOpenClawHostedContext(
	manifest: RuntimeManifest,
	home: string,
): OpenClawHostedContext {
	const stateRoot = join(home, ".openclaw");
	const database = join(stateRoot, "state", "openclaw.sqlite");
	const sourceDir = join(stateRoot, "managed-sources", CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID);
	const installDir = join(stateRoot, "extensions", CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID);
	return {
		home,
		hostedV2: manifest.projection?.sourceBundleVersion === "clawdi.hosted-runtime.bundle.v2",
		enabled: manifest.runtimes.openclaw?.enabled === true,
		managedApiKeyProjection: hasManagedApiKeyProjection(manifest),
		stateRoot,
		configPath: join(stateRoot, "openclaw.json"),
		tmpDir: join(stateRoot, "tmp"),
		ownership: [
			{ path: home, owner: "runtime-user", kind: "directory", recursive: false },
			{
				path: stateRoot,
				owner: "runtime-user",
				kind: "directory",
				mode: 0o700,
				recursive: false,
			},
			{
				path: join(stateRoot, "tmp"),
				owner: "runtime-user",
				kind: "directory",
				mode: 0o700,
				recursive: false,
			},
		],
		agentDirs: {
			root: join(stateRoot, "agents"),
			main: join(stateRoot, "agents", "main", "agent"),
			managed: [],
		},
		providerPlugin: {
			sourceDir,
			installDir,
			mutationTargets: [sourceDir, installDir, database, `${database}-wal`, `${database}-shm`],
		},
		resolveSdkExport(exportName, location) {
			const startPaths = [location.commandPath, location.appRoot];
			switch (exportName) {
				case "config-mutation":
					return resolveOpenClawConfigMutationSdkExport(home, startPaths);
				case "device-bootstrap":
					return resolveOpenClawDeviceBootstrapSdkExport(home, startPaths);
				case "provider-auth":
					return resolveOpenClawProviderAuthSdkExport(home, startPaths);
				case "provider-env-vars":
					return resolveOpenClawProviderEnvVarsSdkExport(home, startPaths);
			}
		},
	};
}

function hasManagedApiKeyProjection(manifest: RuntimeManifest): boolean {
	const runtime = manifest.runtimes.openclaw;
	const sourceProviderId = runtime?.provider_ids?.[0];
	const sourceProvider = sourceProviderId
		? recordValue(manifest.projection?.providers?.[sourceProviderId])
		: null;
	const projectionInput = agentTargetProjectionInput(hostedAiProviderCatalog(manifest, "openclaw"));
	const provider = projectionInput?.catalog.providers.find(
		(entry) => entry.id === CLAWDI_MANAGED_PROVIDER_ID,
	);
	return (
		manifest.projection?.sourceBundleVersion === "clawdi.hosted-runtime.bundle.v2" &&
		runtime?.enabled === true &&
		runtime.providerMode === "configured" &&
		typeof sourceProviderId === "string" &&
		isClawdiManagedV2ProviderId(sourceProviderId) &&
		sourceProvider?.managed_by === "clawdi" &&
		stringValue(sourceProvider.apiKeySecretRef) !== null &&
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

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}
