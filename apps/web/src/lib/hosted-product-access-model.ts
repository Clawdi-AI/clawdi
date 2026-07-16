export interface HostedProductCapabilities {
	can_use_v1?: boolean;
	can_use_v2?: boolean;
	can_use_plan_c_billing?: boolean;
}

export interface HostedProductAccessProfile {
	capabilities?: HostedProductCapabilities | null;
}

export interface HostedProductAccess {
	canUseLegacyHostedDashboard: boolean;
	canCreateCloudAgents: boolean;
	canUsePlanCBilling: boolean;
	/**
	 * Back-compat alias for the rollout flag. New code should choose the
	 * narrower `canCreateCloudAgents` name so existing deployment management
	 * does not accidentally depend on new-deploy availability.
	 */
	canUseCloudAgents: boolean;
}

export function hostedProductAccessFromProfile(
	profile: HostedProductAccessProfile | undefined,
): HostedProductAccess {
	const capabilities = profile?.capabilities;
	const canCreateCloudAgents = capabilities?.can_use_v2 === true;
	return {
		canUseLegacyHostedDashboard: capabilities?.can_use_v1 === true,
		canCreateCloudAgents,
		canUsePlanCBilling: capabilities?.can_use_plan_c_billing === true,
		canUseCloudAgents: canCreateCloudAgents,
	};
}
