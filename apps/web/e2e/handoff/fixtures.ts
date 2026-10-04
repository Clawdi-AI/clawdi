import { type BrowserContext, expect } from "@playwright/test";

export { test } from "@playwright/test";
export const marketing = "http://marketing:3000";
export const cloud = "http://localhost:3200";

export async function isolateNetwork(context: BrowserContext) {
	await context.route("**/*", (route) => {
		const host = new URL(route.request().url()).hostname;
		return ["marketing", "localhost", "127.0.0.1"].includes(host)
			? route.continue()
			: route.abort();
	});
}

export function observeCloudHandoff(context: BrowserContext, destinations: URL[] = []) {
	// The harness HTTP proxy remaps only the Cloud origin. Observe its original
	// response while the browser follows real redirects and delivers cookies.
	context.on("response", (response) => {
		if (!response.url().startsWith(`${marketing}/api/cloud-handoff?`)) return;
		const target = new URL(response.headers()["x-fixture-cloud-location"]);
		expect(target.origin).toBe("https://cloud.clawdi.ai");
		destinations.push(target);
	});
}
