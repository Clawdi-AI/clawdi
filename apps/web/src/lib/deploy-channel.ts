const BASE_ORIGIN = "https://clawdi.invalid";

export type DeployChannelId = "sui";

export type DeployChannelConfig = {
	id: DeployChannelId;
	defaultSubscriptionSource: "included" | null;
	pluginBundle: "sui" | null;
};

export const DEPLOY_CHANNELS: Readonly<Record<DeployChannelId, DeployChannelConfig>> = {
	sui: {
		id: "sui",
		defaultSubscriptionSource: "included",
		pluginBundle: "sui",
	},
};

export function deployChannelConfig(channel: DeployChannelId): DeployChannelConfig {
	return DEPLOY_CHANNELS[channel];
}

function returnUrl(params: URLSearchParams): URL | null {
	const values = params.getAll("redirect_url");
	const value = values.length === 1 ? values[0] : undefined;
	if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
	try {
		const url = new URL(value, BASE_ORIGIN);
		return url.origin === BASE_ORIGIN ? url : null;
	} catch {
		return null;
	}
}

export function resolveDeployChannel(search: string): DeployChannelId | null {
	let params = new URLSearchParams(search);
	if (!params.has("deploy_profile") && !params.has("utm_source")) {
		const nested = returnUrl(params);
		if (!nested) return null;
		params = nested.searchParams;
	}
	const key = params.has("deploy_profile") ? "deploy_profile" : "utm_source";
	const values = params.getAll(key);
	return values.length === 1 && Object.hasOwn(DEPLOY_CHANNELS, values[0] ?? "")
		? (values[0] as DeployChannelId)
		: null;
}

// Normalize direct auth entry links to Clerk's native return URL contract.
export function deployChannelAuthSearch(search: string): string | null {
	const params = new URLSearchParams(search);
	const channel = resolveDeployChannel(search);
	if (!channel || (!params.has("deploy_profile") && !params.has("utm_source")))
		return null;
	const target = returnUrl(params) ?? new URL("/deploy", BASE_ORIGIN);
	target.searchParams.set("deploy_profile", deployChannelConfig(channel).id);
	params.delete("deploy_profile");
	params.delete("utm_source");
	params.set("redirect_url", `${target.pathname}${target.search}${target.hash}`);
	return `?${params}`;
}
