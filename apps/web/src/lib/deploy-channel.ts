const BASE_ORIGIN = "https://clawdi.invalid";

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

export function resolveDeployChannel(search: string): "sui" | null {
	const params = new URLSearchParams(search);
	const key = params.has("deploy_profile") ? "deploy_profile" : "utm_source";
	if (params.has(key)) {
		const values = params.getAll(key);
		return values.length === 1 && values[0] === "sui" ? "sui" : null;
	}
	const nested = returnUrl(params);
	if (!nested) return null;
	const nestedKey = nested.searchParams.has("deploy_profile") ? "deploy_profile" : "utm_source";
	const values = nested.searchParams.getAll(nestedKey);
	return values.length === 1 && values[0] === "sui" ? "sui" : null;
}

export function clearDeployChannelUrl(href: string): string {
	const url = new URL(href, BASE_ORIGIN);
	const clear = (params: URLSearchParams) => {
		if (params.get("deploy_profile") === "sui") params.delete("deploy_profile");
		if (params.get("utm_source") === "sui") params.delete("utm_source");
	};
	clear(url.searchParams);
	const nested = returnUrl(url.searchParams);
	if (nested) {
		clear(nested.searchParams);
		url.searchParams.set("redirect_url", `${nested.pathname}${nested.search}${nested.hash}`);
	}
	return `${url.pathname}${url.search}${url.hash}`;
}

// Normalize direct auth entry links to Clerk's native return URL contract.
export function deployChannelAuthSearch(search: string): string | null {
	const params = new URLSearchParams(search);
	if (!resolveDeployChannel(search) || (!params.has("deploy_profile") && !params.has("utm_source")))
		return null;
	const target = returnUrl(params) ?? new URL("/deploy", BASE_ORIGIN);
	target.searchParams.set("deploy_profile", "sui");
	params.delete("deploy_profile");
	params.delete("utm_source");
	params.set("redirect_url", `${target.pathname}${target.search}${target.hash}`);
	return `?${params}`;
}
