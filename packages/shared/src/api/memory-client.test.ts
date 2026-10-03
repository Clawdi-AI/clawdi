import { expect, test } from "bun:test";
import { createCloudApiClient } from "./read-clients";

test("memory mutations preserve authenticated bodies and encode resource identifiers", async () => {
	const requests: { method: string; path: string; body: unknown }[] = [];
	const client = createCloudApiClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "test-token",
		fetch: async (request) => {
			expect(request.headers.get("Authorization")).toBe("Bearer test-token");
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				body: request.method === "DELETE" ? null : await request.json(),
			});
			return Response.json({});
		},
	});
	await client.createMemory({ content: "Remember this", category: "fact", source: "manual" });
	await client.updateMemory("memory/a?b", "Updated content");
	await client.deleteMemory("memory/a?b");
	expect(requests).toEqual([
		{
			method: "POST",
			path: "/v1/memories",
			body: { content: "Remember this", category: "fact", source: "manual" },
		},
		{ method: "PATCH", path: "/v1/memories/memory%2Fa%3Fb", body: { content: "Updated content" } },
		{ method: "DELETE", path: "/v1/memories/memory%2Fa%3Fb", body: null },
	]);
});
