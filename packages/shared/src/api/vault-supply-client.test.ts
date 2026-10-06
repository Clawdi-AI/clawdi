import { expect, test } from "bun:test";
import { ApiClientError, ApiClientNetworkError } from "./read-transport";
import { createVaultSupplyClient } from "./vault-supply-client";

const token = `v2_${"a".repeat(43)}`;
test("capability requests carry no account auth, cookies, URL token, redirects or caching", async () => {
	const requests: Request[] = [];
	const policies: (RequestInit | undefined)[] = [];
	const bodies: unknown[] = [];
	const client = createVaultSupplyClient({
		baseUrl: "https://api.example.com",
		fetch: async (request, init) => {
			policies.push(init);
			requests.push(request);
			bodies.push(await request.json());
			return Response.json({ status: "pending" });
		},
	});
	await client.inspect(token);
	await client.inspect(token, ["Exact.Name"]);
	await client.supply(token, { "Exact.Name": "synthetic-secret" });
	expect(bodies).toEqual([
		{ token },
		{ token, fields: ["Exact.Name"] },
		{ token, fields: { "Exact.Name": "synthetic-secret" } },
	]);
	for (const request of requests) {
		expect(request.headers.has("authorization")).toBe(false);
		expect(request.headers.has("cookie")).toBe(false);
		expect(request.url).not.toContain(token);
		expect(request.url).not.toContain("synthetic-secret");
		expect(request.redirect).toBe("error");
		expect(request.cache).toBe("no-store");
	}
	for (const policy of policies) {
		expect(policy).toMatchObject({
			credentials: "omit",
			cache: "no-store",
			redirect: "error",
			referrerPolicy: "no-referrer",
		});
	}
});
test("invalid capability and prior cancellation never invoke fetch", async () => {
	let calls = 0;
	const client = createVaultSupplyClient({
		baseUrl: "https://api.example.com",
		fetch: async () => {
			calls++;
			return Response.json({});
		},
	});
	await expect(client.inspect("invalid-secret")).rejects.toBeInstanceOf(ApiClientError);
	const controller = new AbortController();
	controller.abort();
	await expect(client.inspect(token, undefined, controller.signal)).rejects.toMatchObject({
		name: "AbortError",
	});
	expect(calls).toBe(0);
});
test("timeout covers stalled fetch and response body without retrying", async () => {
	for (const stallBody of [false, true]) {
		let calls = 0;
		const client = createVaultSupplyClient({
			baseUrl: "https://api.example.com",
			timeoutMs: 10,
			fetch: async () => {
				calls++;
				if (stallBody)
					return new Response(new ReadableStream({ start() {} }), {
						headers: { "content-type": "application/json" },
					});
				return await new Promise<Response>(() => {});
			},
		});
		await expect(client.inspect(token)).rejects.toBeInstanceOf(ApiClientNetworkError);
		expect(calls).toBe(1);
	}
});
test("server errors are status-only and never echo secret-bearing details", async () => {
	const client = createVaultSupplyClient({
		baseUrl: "https://api.example.com",
		fetch: async () => Response.json({ detail: token }, { status: 409 }),
	});
	await expect(client.supply(token, { KEY: "synthetic-secret" })).rejects.toMatchObject({
		status: 409,
		message: "API request failed (409)",
	});
});
