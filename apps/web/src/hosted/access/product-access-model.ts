import type { DeployComponents } from "@clawdi/shared/api";

type HostedProductCapabilities = Partial<DeployComponents["schemas"]["V1UserProductCapabilities"]>;

export interface HostedProductAccessProfile {
	capabilities?: HostedProductCapabilities | null;
}

/** `disabled` is authoritative only after a successful profile response. */
export type LegacyHostedAccessStatus = "unresolved" | "enabled" | "disabled";

export interface HostedProductAccess {
	canUseLegacyHostedDashboard: boolean;
	legacyHostedAccessStatus: LegacyHostedAccessStatus;
	canCreateCloudAgents: boolean;
	/**
	 * Back-compat alias for the rollout flag. New code should choose the
	 * narrower `canCreateCloudAgents` name so existing deployment management
	 * does not accidentally depend on new-deploy availability.
	 */
	canUseCloudAgents: boolean;
}

export type HostedProductAccessStatus = "unavailable" | "loading" | "error" | "allowed" | "denied";

export function hostedProductAccessStatus({
	enabled,
	profile,
	isFetching,
	error,
}: {
	enabled: boolean;
	profile: HostedProductAccessProfile | undefined;
	isFetching: boolean;
	error: unknown;
}): HostedProductAccessStatus {
	if (!enabled) return "unavailable";
	// Fresh or cached successful data is authoritative, including an explicit
	// denial. A failed background refresh must not erase the last known result.
	if (profile !== undefined) {
		return profile.capabilities?.can_use_v2 === true ? "allowed" : "denied";
	}
	if (isFetching) return "loading";
	if (error) return "error";
	return "loading";
}

export function hostedProductAccessFromProfile(
	profile: HostedProductAccessProfile | undefined,
): HostedProductAccess {
	const capabilities = profile?.capabilities;
	const legacyHostedAccessStatus =
		profile === undefined
			? "unresolved"
			: capabilities?.can_use_v1 === true
				? "enabled"
				: "disabled";
	const canCreateCloudAgents = capabilities?.can_use_v2 === true;
	return {
		canUseLegacyHostedDashboard: legacyHostedAccessStatus === "enabled",
		legacyHostedAccessStatus,
		canCreateCloudAgents,
		canUseCloudAgents: canCreateCloudAgents,
	};
}
