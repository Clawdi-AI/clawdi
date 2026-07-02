export interface HostedProductCapabilities {
	can_use_v1?: boolean;
	can_use_v2?: boolean;
}

export interface HostedProductAccessProfile {
	capabilities?: HostedProductCapabilities | null;
}

export interface HostedProductAccess {
	canUseLegacyHostedDashboard: boolean;
	canUseCloudAgents: boolean;
}

export function hostedProductAccessFromProfile(
	profile: HostedProductAccessProfile | undefined,
): HostedProductAccess {
	const capabilities = profile?.capabilities;
	return {
		canUseLegacyHostedDashboard: capabilities?.can_use_v1 === true,
		canUseCloudAgents: capabilities?.can_use_v2 === true,
	};
}
