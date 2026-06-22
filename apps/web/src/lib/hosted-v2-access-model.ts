export interface HostedProductCapabilities {
	can_use_v2?: boolean;
}

export interface HostedAccessProfile {
	capabilities?: HostedProductCapabilities | null;
}

export interface HostedV2Access {
	canUseV2: boolean;
}

export function hostedV2AccessFromProfile(
	profile: HostedAccessProfile | undefined,
): HostedV2Access {
	const capabilities = profile?.capabilities;
	return {
		canUseV2: capabilities?.can_use_v2 === true,
	};
}
