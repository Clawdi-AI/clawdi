export function hostedV2ApiBaseUrl(rawBaseUrl: string): string {
	const url = new URL(rawBaseUrl);
	const normalizedPath = url.pathname.replace(/\/+$/, "");
	url.pathname = normalizedPath.endsWith("/v2") ? normalizedPath : `${normalizedPath}/v2`;
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}
