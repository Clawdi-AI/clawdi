const DEFAULT_DASHBOARD_URL = "https://cloud.clawdi.ai";

/** Dashboard authentication belongs to the user's browser, independently of the CLI. */
export async function openDashboardInBrowser(
	openExternal: (url: string) => Promise<void>,
	configuredUrl = DEFAULT_DASHBOARD_URL,
): Promise<void> {
	let url: URL;
	try {
		url = new URL(configuredUrl);
	} catch {
		throw new Error("The Desktop dashboard URL is invalid.");
	}
	const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"The Desktop dashboard URL must be HTTPS or a local HTTP URL without credentials, query, or fragment.",
		);
	}
	try {
		await openExternal(url.href);
	} catch {
		throw new Error(
			"Could not open the system browser. Open Clawdi in your browser and try again.",
		);
	}
}
