import { expect, test } from "bun:test";
import { createCloudApiClient } from "./read-clients";

test("project writes preserve generated payloads, owner authentication and escaped identifiers", async () => {
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
	await client.createProject({ name: "Research", description: "Notes" });
	await client.updateProject("project/a?b", { name: "Updated", description: null });
	await client.archiveProject("project/a?b");
	expect(requests).toEqual([
		{ method: "POST", path: "/v1/projects", body: { name: "Research", description: "Notes" } },
		{
			method: "PATCH",
			path: "/v1/projects/project%2Fa%3Fb",
			body: { name: "Updated", description: null },
		},
		{ method: "DELETE", path: "/v1/projects/project%2Fa%3Fb", body: null },
	]);
});
