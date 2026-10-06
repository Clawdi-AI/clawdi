import { expect, test } from "bun:test";
import type { components } from "./api.generated";
import { createSkillClient } from "./skill-client";

test("Library Skill resolution is authenticated, encoded and identity-checked without Project fallback", async () => {
	const skill: components["schemas"]["SkillDetailResponse"] = {
		id: "skill",
		skill_key: "group/demo",
		name: "Demo",
		description: null,
		version: 1,
		source: "local",
		authority: "cloud",
		source_repo: null,
		file_count: 1,
		content: "Instructions",
		agent_types: null,
		created_at: "2026-10-03T00:00:00Z",
		content_hash: "a".repeat(64),
		project_id: "resolved-project",
	};
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			expect(request.headers.get("Authorization")).toBe("Bearer test-token");
			expect(request.method).toBe("GET");
			const path = new URL(request.url).pathname;
			requests.push(path);
			return path.startsWith("/v1/projects/")
				? Response.json({ detail: "Not found" }, { status: 404 })
				: Response.json(skill);
		},
	});
	try {
		const client = createSkillClient({
			baseUrl: server.url.toString(),
			getToken: async () => "test-token",
			fetch,
		});
		expect(await client.getLibrary("group/demo")).toEqual(skill);
		await expect(client.getLibrary("other")).rejects.toThrow();
		await expect(client.get("explicit-project", "group/demo")).rejects.toMatchObject({
			status: 404,
		});
		expect(requests).toEqual([
			"/v1/skills/group%2Fdemo",
			"/v1/skills/other",
			"/v1/projects/explicit-project/skills/group%2Fdemo",
		]);
	} finally {
		await server.stop(true);
	}
});

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
