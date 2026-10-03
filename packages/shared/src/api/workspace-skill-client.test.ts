import { expect, test } from "bun:test";
import { createWorkspaceSkillClient } from "./workspace-skill-client";
import { parseWorkspaceSkillGitHubInput } from "./workspace-skill-policy";

const source = {
	type: "github",
	url: "https://github.com/owner/repo",
	path: "skills/demo",
	commit: "a".repeat(40),
};
test("Workspace Skill writes retain exact headers/body; version conflicts do not refresh or retry", async () => {
	const seen: {
		method: string;
		path: string;
		version: string | null;
		key: string | null;
		body: unknown;
	}[] = [];
	let conflict = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			const path = new URL(request.url).pathname;
			seen.push({
				path,
				method: request.method,
				version: request.headers.get("if-match"),
				key: request.headers.get("idempotency-key"),
				body: request.method === "POST" ? await request.json() : null,
			});
			if (conflict)
				return Response.json({ detail: { code: "resource_version_mismatch" } }, { status: 412 });
			if (request.method === "GET")
				return path.endsWith("/workspace-skills")
					? Response.json({
							deployment_id: "dep",
							deployment_resource_version: "rv1",
							manifest_generation: 1,
							capability: { available: true, reason: "available" },
							items: [],
						})
					: Response.json({
							skill_key: "nested/demo",
							content: "Skill instructions",
							source,
							name: "Demo",
							description: "Example",
						});
			return Response.json({
				deployment_id: "dep",
				deployment_resource_version: "rv2",
				manifest_generation: 2,
				skill_key: "nested/demo",
				desired_state: request.method === "POST" ? "present" : "absent",
				status: "requested",
				source,
			});
		},
	});
	try {
		const client = createWorkspaceSkillClient({
			baseUrl: `${server.url.href}v2`,
			getToken: async () => "fixture",
			fetch,
		});
		await client.list("dep");
		await client.get("dep", "nested/demo");
		const mutation = {
			action: "install" as const,
			request: { repo: "owner/repo", path: "skills/demo" },
		};
		await client.apply("dep", "rv1", "saved-key", mutation);
		await client.apply("dep", "rv2", "delete-key", {
			action: "uninstall",
			skillKey: "nested/demo",
		});
		expect(seen[2]).toEqual({
			path: "/v2/deployments/dep/workspace-skills",
			method: "POST",
			version: '"rv1"',
			key: "saved-key",
			body: mutation.request,
		});
		expect(seen[3]).toEqual({
			path: "/v2/deployments/dep/workspace-skills/nested%2Fdemo",
			method: "DELETE",
			version: '"rv2"',
			key: "delete-key",
			body: null,
		});
		conflict = true;
		const before = seen.length;
		await expect(client.apply("dep", "rv1", "saved-key", mutation)).rejects.toMatchObject({
			status: 412,
			code: "resource_version_mismatch",
		});
		expect(seen.length).toBe(before + 1);
		expect(seen.at(-1)).toEqual(seen[2]);
	} finally {
		server.stop(true);
	}
});

test("reserved Skill/header errors stay local and foreign response identities fail closed", async () => {
	let tokens = 0;
	const client = createWorkspaceSkillClient({
		baseUrl: "https://hosted.example",
		getToken: async () => {
			tokens++;
			return "fixture";
		},
		fetch: async () => Response.json({ deployment_id: "foreign", skill_key: "foreign" }),
	});
	await expect(
		client.apply("dep", "rv1", "key", { action: "uninstall", skillKey: "clawdi" }),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		client.apply("dep", "rv1", "bad\nkey", { action: "uninstall", skillKey: "demo" }),
	).rejects.toMatchObject({ status: 400 });
	expect(tokens).toBe(0);
	await expect(client.list("dep")).rejects.toThrow("API response could not be read");
	await expect(client.get("dep", "demo")).rejects.toThrow("API response could not be read");
	for (const path of [
		"https://github.com/owner/repo/../other",
		"https://github.com/owner/repo/%2e%2e/other",
		"owner/repo/a\\b",
	])
		expect(() => parseWorkspaceSkillGitHubInput(path)).toThrow();
});
