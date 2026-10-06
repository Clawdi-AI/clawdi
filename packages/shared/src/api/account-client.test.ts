import { expect, test } from "bun:test";
import { createAccountApiClient } from "./account-client";

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
	await client.revokeApiKey("key/with?symbols");
	expect(requests).toEqual([
		{ method: "GET", path: "/v1/settings", body: null },
		{ method: "PATCH", path: "/v1/settings", body: { settings: { memory_enabled: false } } },
		{ method: "GET", path: "/v1/auth/keys", body: null },
		{ method: "DELETE", path: "/v1/auth/keys/key%2Fwith%3Fsymbols", body: null },
	]);
});
