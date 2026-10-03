import { expect, test } from "bun:test";
import { createAgentProjectClient } from "./agent-project-client";
import { type AgentProjectBinding, buildContextBindingReorder } from "./project-scope";
import { ApiClientError } from "./read-transport";

function binding(id: string, type: string, priority: number): AgentProjectBinding {
	return {
		id,
		agent_id: "agent",
		project_id: `project-${id}`,
		binding_type: type,
		priority,
		default_write_enabled: type === "primary",
		created_at: "2026-10-03T00:00:00Z",
	};
}

test("context reorder follows shared read order and never includes or mutates the Workspace", () => {
	const rows = [
		binding("later", "context", 8),
		binding("workspace", "primary", 0),
		binding("earlier", "context", 2),
	];
	expect(buildContextBindingReorder(rows, "later", -1)).toEqual({
		items: [
			{ binding_id: "later", priority: 1 },
			{ binding_id: "earlier", priority: 2 },
		],
	});
	expect(rows.map((row) => row.priority)).toEqual([8, 0, 2]);
	expect(() => buildContextBindingReorder(rows, "workspace", 1)).toThrow();
	expect(() => buildContextBindingReorder(rows, "earlier", -1)).toThrow();
	expect(() =>
		buildContextBindingReorder(
			[rows[0], rows[0]].filter((row): row is AgentProjectBinding => Boolean(row)),
			"later",
			1,
		),
	).toThrow();
});

test("Agent Project client keeps authentication, escaped paths and generated mutation bodies", async () => {
	const requests: { method: string; path: string; body: unknown }[] = [];
	const client = createAgentProjectClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "test-token",
		fetch: async (request) => {
			expect(request.headers.get("Authorization")).toBe("Bearer test-token");
			const body = await request.text();
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				body: body ? JSON.parse(body) : null,
			});
			return Response.json({});
		},
	});
	await client.listBindings("agent/a");
	await client.link("agent/a", "project");
	await client.unlink("agent/a", "binding/b");
	const order = { items: [{ binding_id: "context", priority: 1 }] };
	await client.reorder("agent/a", order);
	expect(requests).toEqual([
		{ method: "GET", path: "/v1/agents/agent%2Fa/project-bindings", body: null },
		{
			method: "POST",
			path: "/v1/agents/agent%2Fa/project-bindings/context",
			body: { project_id: "project" },
		},
		{ method: "DELETE", path: "/v1/agents/agent%2Fa/project-bindings/binding%2Fb", body: null },
		{ method: "PATCH", path: "/v1/agents/agent%2Fa/project-bindings/context/reorder", body: order },
	]);
});

test("Agent Project mutations never retry conflicts or send unauthenticated writes", async () => {
	let calls = 0;
	const options = {
		baseUrl: "https://api.example.test",
		getToken: async (): Promise<string | null> => "test-token",
		fetch: async () => {
			calls += 1;
			return Response.json({ detail: "conflict" }, { status: 409 });
		},
	};
	await expect(createAgentProjectClient(options).unlink("agent", "binding")).rejects.toBeInstanceOf(
		ApiClientError,
	);
	await expect(
		createAgentProjectClient({ ...options, getToken: async () => null }).link("agent", "project"),
	).rejects.toBeInstanceOf(ApiClientError);
	expect(calls).toBe(1);
});
