export function hostedApiBaseUrl(rawBaseUrl: string): string {
	const url = new URL(rawBaseUrl);
	url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v2$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

export function hostedV2ApiBaseUrl(rawBaseUrl: string): string {
	const url = new URL(hostedApiBaseUrl(rawBaseUrl));
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/v2`;
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}
