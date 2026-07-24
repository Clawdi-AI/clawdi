import type { HostedDeployment } from "@/hosted/billing/contracts";

export interface ProviderUsage {
	known: boolean;
	agentCount: number;
}

export interface ProviderRemovalImpact {
	acknowledgementRequired: boolean;
	warning: string;
}

/**
 * Resolve provider usage from the authoritative hosted runtime configuration.
 * `null` means the inventory has never loaded, so deletion must be treated as
 * potentially destructive rather than as a known-unused provider.
 */
export function providerUsage(
	providerId: string,
	deployments: readonly HostedDeployment[] | null,
): ProviderUsage {
	if (deployments === null) return { known: false, agentCount: 0 };
	const agentCount = deployments.filter((deployment) => {
		const config = deployment.resource.spec.runtime_configuration;
		return (
			config.primary_model?.provider_id === providerId ||
			config.providers.some((provider) => provider.provider_id === providerId)
		);
	}).length;
	return { known: true, agentCount };
}

export function providerRemovalImpact(usage: ProviderUsage): ProviderRemovalImpact {
	if (!usage.known) {
		return {
			acknowledgementRequired: true,
			warning:
				"Removing this provider archives it. We couldn't check whether any agents use it. Any affected agent will lose model access until reconfigured; there is no automatic fallback to the managed default.",
		};
	}
	if (usage.agentCount > 0) {
		const agents =
			usage.agentCount === 1
				? "1 agent currently uses"
				: `${usage.agentCount} agents currently use`;
		return {
			acknowledgementRequired: true,
			warning: `Removing this provider archives it. ${agents} it and will lose model access until reconfigured; there is no automatic fallback to the managed default.`,
		};
	}
	return {
		acknowledgementRequired: false,
		warning:
			"Removing this provider archives it. No hosted agents currently use it, but this can't be undone.",
	};
}
