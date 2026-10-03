import { expect, test } from "bun:test";
import { createAccountApiClient } from "./account-client";
import { ApiClientError } from "./read-transport";

test("account requests preserve authentication, methods, bodies and escaped key ids", async () => {
	const requests: { method: string; path: string; body: unknown }[] = [];
	const client = createAccountApiClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "test-token",
		fetch: async (request) => {
			expect(request.headers.get("Authorization")).toBe("Bearer test-token");
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				body: request.method === "POST" || request.method === "PATCH" ? await request.json() : null,
			});
			return Response.json({});
		},
	});
	await client.getSettings();
	await client.updateSettings({ settings: { memory_enabled: false } });
	await client.listApiKeys();
	await client.createApiKey({ label: "Phone" });
	await client.revokeApiKey("key/with?symbols");
	expect(requests).toEqual([
		{ method: "GET", path: "/v1/settings", body: null },
		{ method: "PATCH", path: "/v1/settings", body: { settings: { memory_enabled: false } } },
		{ method: "GET", path: "/v1/auth/keys", body: null },
		{ method: "POST", path: "/v1/auth/keys", body: { label: "Phone" } },
		{ method: "DELETE", path: "/v1/auth/keys/key%2Fwith%3Fsymbols", body: null },
	]);
});

test("account mutations do not retry failures or send without authentication", async () => {
	let calls = 0;
	const options = {
		baseUrl: "https://api.example.test",
		getToken: async (): Promise<string | null> => "test-token",
		fetch: async () => {
			calls += 1;
			return Response.json({ detail: { code: "not_allowed" } }, { status: 403 });
		},
	};
	await expect(
		createAccountApiClient(options).createApiKey({ label: "Phone" }),
	).rejects.toBeInstanceOf(ApiClientError);
	expect(calls).toBe(1);
	await expect(
		createAccountApiClient({ ...options, getToken: async () => null }).createApiKey({
			label: "Phone",
		}),
	).rejects.toBeInstanceOf(ApiClientError);
	expect(calls).toBe(1);
});
