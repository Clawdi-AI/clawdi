import type {
	DeploymentUpdateRequest,
	HostedDeployment,
	HostedProviderConflict,
} from "@/hosted/billing/contracts";
import { buildAiBindingFields } from "@/hosted/v2/ai-providers/ai-provider-binding";
import { isManagedProviderId } from "@/hosted/v2/ai-providers/model-binding";

export type HostedProviderConflictCode = HostedProviderConflict["code"];

export type ProviderConflictNotice = {
	providerId: string;
	runtime: HostedProviderConflict["runtime"];
	code: HostedProviderConflictCode;
	/** The conflicting provider is this agent's only Clawdi provider binding. */
	removable: boolean;
};

function sameProvider(conflictProviderId: string, boundProviderId: string): boolean {
	// Clawdi AI is projected publicly under one stable id while the runtime
	// reports its per-deployment managed id.
	return (
		conflictProviderId === boundProviderId ||
		(isManagedProviderId(conflictProviderId) && isManagedProviderId(boundProviderId))
	);
}

/**
 * Clawdi providers the running agent skipped because its own Hermes/OpenClaw
 * configuration already owns them ("native wins"). One notice per provider on
 * this agent's runtime; a missing field from an older backend means none.
 */
export function providerConflictNotices(deployment: HostedDeployment): ProviderConflictNotice[] {
	const runtime = deployment.resource.spec.runtime;
	const boundProviders = deployment.resource.spec.runtime_configuration.providers;
	const soleBinding = boundProviders.length === 1 ? boundProviders[0] : undefined;
	const notices: ProviderConflictNotice[] = [];
	const seen = new Set<string>();
	for (const conflict of deployment.provider_conflicts ?? []) {
		if (conflict.runtime !== runtime || seen.has(conflict.provider_id)) continue;
		seen.add(conflict.provider_id);
		notices.push({
			providerId: conflict.provider_id,
			runtime: conflict.runtime,
			code: conflict.code,
			removable:
				soleBinding !== undefined && sameProvider(conflict.provider_id, soleBinding.provider_id),
		});
	}
	return notices;
}

/**
 * The display id for a conflicting provider: the agent's bound provider id, so
 * Clawdi AI resolves to its public label instead of an internal managed id.
 */
export function providerConflictDisplayId(
	notice: ProviderConflictNotice,
	deployment: HostedDeployment,
): string {
	const bound = deployment.resource.spec.runtime_configuration.providers.find((provider) =>
		sameProvider(notice.providerId, provider.provider_id),
	);
	return bound?.provider_id ?? notice.providerId;
}

/**
 * "Keep the agent's own settings": remove this agent's Clawdi provider binding
 * through the existing update flow. A deployment holds at most one canonical
 * provider binding, so removing it leaves model access configured inside the
 * agent — the native settings that already won.
 */
export function keepAgentOwnSettingsUpdate(): DeploymentUpdateRequest {
	return buildAiBindingFields(
		{ bindingMode: "unmanaged", primaryProviderChoice: "", primaryModel: "" },
		{ managedModels: [], mode: "update", providers: [] },
	);
}
