import { expect, test } from "bun:test";
import { createAgentExtensionsClient } from "./agent-extensions-client";
import { ApiClientError, ApiClientResponseError } from "./read-transport";

test("malformed catalogs and foreign Agent inventories fail before reaching presentation", async () => {
	const client = createAgentExtensionsClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "token",
		fetch: async (request) =>
			Response.json(
				new URL(request.url).pathname === "/v1/plugin-catalog"
					? { plugins: [{ name: "broken" }] }
					: { agent_id: "other", skills: [] },
			),
	});
	await expect(client.catalog()).rejects.toBeInstanceOf(ApiClientResponseError);
	await expect(client.listSkills("agent")).rejects.toBeInstanceOf(ApiClientResponseError);
});

test("reference mutations use stable IDs, escaped paths and exact desired receipts", async () => {
	const calls: { method: string; path: string; body: string }[] = [];
	const client = createAgentExtensionsClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "token",
		fetch: async (request) => {
			expect(request.headers.get("Authorization")).toBe("Bearer token");
			calls.push({
				method: request.method,
				path: new URL(request.url).pathname,
				body: await request.text(),
			});
			return Response.json(
				{
					agent_id: "agent/a",
					skill_id: "stable/id",
					desired_state: request.method === "PUT" ? "present" : "absent",
				},
				{ status: 202 },
			);
		},
	});
	await client.setLibraryReference("agent/a", "stable/id", true);
	await client.setLibraryReference("agent/a", "stable/id", false);
	expect(calls).toEqual([
		{ method: "PUT", path: "/v1/agents/agent%2Fa/skill-references/stable%2Fid", body: "" },
		{ method: "DELETE", path: "/v1/agents/agent%2Fa/skill-references/stable%2Fid", body: "" },
	]);
});

test("plugin install pins selected version and rejects mismatched receipt without retry", async () => {
	let calls = 0;
	const client = createAgentExtensionsClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "token",
		fetch: async (request) => {
			calls++;
			expect(await request.json()).toEqual({ version: "1.2.3" });
			return Response.json(
				{
					agent_id: "agent",
					plugin_name: "plugin",
					version: "2.0.0",
					desired_state: "present",
					convergence: "installed",
				},
				{ status: 202 },
			);
		},
	});
	await expect(client.installPlugin("agent", "plugin", "1.2.3")).rejects.toBeInstanceOf(
		ApiClientResponseError,
	);
	expect(calls).toBe(1);
});

test("foreign Agent receipts fail closed and server rejection never automatically retries", async () => {
	let calls = 0;
	const client = createAgentExtensionsClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "token",
		fetch: async () => {
			calls++;
			return calls === 1
				? Response.json(
						{ agent_id: "other", skill_id: "skill", desired_state: "present" },
						{ status: 202 },
					)
				: Response.json({ detail: { code: "hosted_v2_runtime_required" } }, { status: 409 });
		},
	});
	await expect(client.setLibraryReference("agent", "skill", true)).rejects.toBeInstanceOf(
		ApiClientResponseError,
	);
	await expect(client.removePlugin("agent", "plugin")).rejects.toBeInstanceOf(ApiClientError);
	expect(calls).toBe(2);
});
