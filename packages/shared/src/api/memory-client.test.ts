import { expect, test } from "bun:test";
import { createCloudApiClient } from "./read-clients";
import { ApiClientError } from "./read-transport";

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

test("memory mutation errors are not retried and aborted actions never reach the network", async () => {
	let calls = 0;
	const client = createCloudApiClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "test-token",
		fetch: async () => {
			calls += 1;
			return Response.json({ detail: "denied" }, { status: 403 });
		},
	});
	await expect(client.deleteMemory("memory-id")).rejects.toBeInstanceOf(ApiClientError);
	expect(calls).toBe(1);
	const controller = new AbortController();
	controller.abort();
	await expect(
		client.updateMemory("memory-id", "content", controller.signal),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(calls).toBe(1);
});
