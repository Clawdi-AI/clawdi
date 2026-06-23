export interface V2ProductCapabilities {
	can_use_v2?: boolean;
}

export interface V2AccessProfile {
	capabilities?: V2ProductCapabilities | null;
}

export interface V2Access {
	canUseV2: boolean;
}

export function v2AccessFromProfile(profile: V2AccessProfile | undefined): V2Access {
	const capabilities = profile?.capabilities;
	return {
		canUseV2: capabilities?.can_use_v2 === true,
	};
}
