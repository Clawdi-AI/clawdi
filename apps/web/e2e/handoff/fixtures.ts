import { createServer } from "node:http";
import { type BrowserContext, test as base, expect } from "@playwright/test";

export const marketing = "http://marketing:3000";
export const cloud = "http://localhost:3200";
type OfferRequest = { token: string; authorization: string | undefined };
const offerRequests: OfferRequest[] = [];

// Simulate only the private billing service; credential reads and checkout use
// production server functions and UI. Keep one bounded service per test worker.
export const test = base.extend<{ offerRequests: OfferRequest[] }, { offerApi: undefined }>({
	offerApi: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructuring for fixture dependencies.
		async ({}, use) => {
			const server = createServer(async (request, response) => {
				if (request.url !== "/v2/subscription/trial-offer" || request.method !== "POST") {
					response.writeHead(404).end();
					return;
				}
				try {
					const chunks = [];
					for await (const chunk of request) chunks.push(chunk);
					const body = JSON.parse(Buffer.concat(chunks).toString());
					if (typeof body.token !== "string" || !request.headers.authorization) {
						response.writeHead(400).end();
						return;
					}
					offerRequests.push({ token: body.token, authorization: request.headers.authorization });
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end(JSON.stringify({ available: true, expires_at: "2099-01-01T00:00:00Z" }));
				} catch {
					response.writeHead(400).end();
				}
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(8001, "127.0.0.1", resolve);
			});
			try {
				await use(undefined);
			} finally {
				await new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				});
			}
		},
		{ scope: "worker", auto: true },
	],
	offerRequests: async ({ offerApi }, use) => {
		void offerApi;
		offerRequests.length = 0;
		await use(offerRequests);
	},
});

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
