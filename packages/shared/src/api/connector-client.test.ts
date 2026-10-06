import { expect, test } from "bun:test";
import { createConnectorClient } from "./connector-client";
import { filterConnectorTools } from "./connector-state";

test("tool search matches Web's visible names and descriptions literally without mutating order", () => {
	const tools = [
		{ name: "files.list[v2]", display_name: "List files", description: "Read shared documents" },
		{ name: "users.get", display_name: "Find user", description: "Read account profile" },
	];
	expect(filterConnectorTools(tools, "  FILES.LIST[V2] ")).toEqual([]);
	expect(filterConnectorTools(tools, " LIST FILES ")).toEqual([tools[0]]);
	expect(filterConnectorTools(tools, "find USER")).toEqual([tools[1]]);
	expect(filterConnectorTools(tools, "shared documents")).toEqual([tools[0]]);
	expect(filterConnectorTools(tools, ".*")).toEqual([]);
	expect(filterConnectorTools(tools, "read")).toEqual(tools);
	expect(filterConnectorTools(tools, "   ")).toEqual(tools);
});

test("connector requests preserve provider-managed callback, credentials, aliases and escaped identities", async () => {
	const calls: { path: string; query: string; method: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			calls.push({
				path: url.pathname,
				query: url.search,
				method: request.method,
				body: request.method === "POST" || request.method === "PATCH" ? await request.json() : null,
			});
			return Response.json({ status: "disconnected" });
		},
	});
	try {
		const client = createConnectorClient({
			baseUrl: server.url.href,
			getToken: async () => "fixture",
			fetch,
		});
		await client.catalog({ page: 2, page_size: 24, search: "a &/b" });
		await client.connect("app/name", { alias: "Work" });
		await client.connectCredentials("app/name", { credentials: { api_key: "test-secret" } });
		await client.update("account/a?b", { alias: "" });
		await client.disconnect("account/a?b");
		expect(new URLSearchParams(calls[0]?.query).get("search")).toBe("a &/b");
		expect(calls.slice(1)).toEqual([
			{
				method: "POST",
				path: "/v1/connectors/app%2Fname/connect",
				query: "",
				body: { alias: "Work" },
			},
			{
				method: "POST",
				path: "/v1/connectors/app%2Fname/connect-credentials",
				query: "",
				body: { credentials: { api_key: "test-secret" } },
			},
			{ method: "PATCH", path: "/v1/connectors/account%2Fa%3Fb", query: "", body: { alias: "" } },
			{ method: "DELETE", path: "/v1/connectors/account%2Fa%3Fb", query: "", body: null },
		]);
	} finally {
		server.stop(true);
	}
});
