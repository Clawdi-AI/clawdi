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
			const shares = createServer((request, response) => {
				const path = request.url?.split("?")[0] ?? "";
				const expired = path === "/v1/public/session-shares/11111111-1111-4111-8111-111111111111";
				const legacy = path === "/v1/public/sessions/22222222-2222-4222-8222-222222222222";
				const status = expired ? 410 : legacy ? (request.headers.authorization ? 403 : 401) : 404;
				response.writeHead(status, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ detail: "Unavailable share" }));
			});
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
			let cleanup: PromiseSettledResult<void>[] = [];
			try {
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(8001, "127.0.0.1", resolve);
				});
				await new Promise<void>((resolve, reject) => {
					shares.once("error", reject);
					shares.listen(8000, "127.0.0.1", resolve);
				});
				await use(undefined);
			} finally {
				cleanup = await Promise.allSettled(
					[server, shares].map((service) =>
						service.listening
							? new Promise<void>((resolve, reject) => {
									service.close((error) => (error ? reject(error) : resolve()));
								})
							: Promise.resolve(),
					),
				);
			}
			for (const result of cleanup) if (result.status === "rejected") throw result.reason;
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
