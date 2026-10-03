import { expect, test } from "bun:test";
import { createSkillClient } from "./skill-client";

test("project Skill writes preserve explicit scope and edit/delete revisions", async () => {
	const requests: { method: string; path: string; query: string; body: unknown }[] = [];
	const client = createSkillClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "test-token",
		fetch: async (request) => {
			expect(request.headers.get("Authorization")).toBe("Bearer test-token");
			const url = new URL(request.url);
			const body = await request.text();
			requests.push({
				method: request.method,
				path: url.pathname,
				query: url.search,
				body: body ? JSON.parse(body) : null,
			});
			return Response.json({});
		},
	});
	const draft = { name: "demo", description: "Example", instructions: "Body" };
	const revision = "a".repeat(64);
	await client.get("project/a", "group/demo");
	await client.create("project/a", draft);
	await client.update("project/a", "group/demo", { ...draft, content_hash: revision });
	await client.remove("project/a", "group/demo", revision);
	await client.install("project/a", { repo: "owner/repo", path: "skills/demo" });
	expect(requests).toEqual([
		{ method: "GET", path: "/v1/projects/project%2Fa/skills/group%2Fdemo", query: "", body: null },
		{ method: "POST", path: "/v1/projects/project%2Fa/skills", query: "", body: draft },
		{
			method: "PUT",
			path: "/v1/projects/project%2Fa/skills/group%2Fdemo/content",
			query: "",
			body: { ...draft, content_hash: revision },
		},
		{
			method: "DELETE",
			path: "/v1/projects/project%2Fa/skills/group%2Fdemo",
			query: `?expected_content_hash=${revision}`,
			body: null,
		},
		{
			method: "POST",
			path: "/v1/projects/project%2Fa/skills/install",
			query: "",
			body: { repo: "owner/repo", path: "skills/demo" },
		},
	]);
});

test("missing deletion revision cannot become an unconditional delete", async () => {
	let calls = 0;
	const client = createSkillClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "test-token",
		fetch: async () => {
			calls++;
			return Response.json({});
		},
	});
	await expect(client.remove("project", "demo", "")).rejects.toThrow();
	expect(calls).toBe(0);
});
