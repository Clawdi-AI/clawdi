import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";

export async function startMcpServer() {
	if (!isLoggedIn()) {
		process.stderr.write("Not logged in. Run `clawdi login` first.\n");
		process.exit(1);
	}

	const api = new ApiClient();

	// Get MCP proxy config (Composio session URL + token)
	let mcpConfig: { mcp_url: string; mcp_token: string } | null = null;
	try {
		mcpConfig = await api.get("/api/connectors/mcp-config");
	} catch {
		process.stderr.write("Warning: Could not get MCP proxy config. Composio tools unavailable.\n");
	}

	const server = new McpServer({
		name: "clawdi-cloud",
		version: "0.0.1",
	});

	// --- Clawdi native tools (direct API calls) ---

	server.tool(
		"memory_search",
		"Search memories across all your agents",
		{
			query: { type: "string", description: "Search query" },
			limit: { type: "number", description: "Max results (default 10)" },
		},
		async ({ query, limit }) => {
			try {
				const results = await api.get<any[]>(
					`/api/memories?q=${encodeURIComponent(query as string)}&limit=${limit ?? 10}`,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: results.length
								? results.map((m: any) => `[${m.category}] ${m.content}`).join("\n\n")
								: "No memories found.",
						},
					],
				};
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
			}
		},
	);

	server.tool(
		"memory_add",
		"Store a memory for cross-agent recall",
		{
			content: { type: "string", description: "The memory content to store" },
			category: {
				type: "string",
				description: "Category: fact, preference, pattern, decision, context",
			},
		},
		async ({ content, category }) => {
			try {
				const result = await api.post<{ id: string }>("/api/memories", {
					content,
					category: category ?? "fact",
				});
				return {
					content: [
						{ type: "text" as const, text: `Memory stored (${result.id.slice(0, 8)})` },
					],
				};
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
			}
		},
	);

	// --- Composio connector tools (via backend MCP proxy) ---

	if (mcpConfig) {
		server.tool(
			"connector_call",
			"Call a connected service tool (GitHub, Gmail, Notion, etc.) via Composio. Use connector_list to see available tools first.",
			{
				tool_name: {
					type: "string",
					description:
						"Composio tool name, e.g. GITHUB_LIST_ISSUES, GMAIL_SEND_EMAIL, NOTION_SEARCH_PAGES",
				},
				arguments: {
					type: "string",
					description: "JSON string of tool arguments",
				},
			},
			async ({ tool_name, arguments: args }) => {
				try {
					const rpcPayload = {
						jsonrpc: "2.0",
						id: Date.now(),
						method: "tools/call",
						params: {
							name: tool_name,
							arguments: args ? JSON.parse(args as string) : {},
						},
					};

					const resp = await fetch(mcpConfig!.mcp_url, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${mcpConfig!.mcp_token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(rpcPayload),
					});

					const result = await resp.json();
					if (result.error) {
						return {
							content: [
								{ type: "text" as const, text: `Error: ${JSON.stringify(result.error)}` },
							],
						};
					}
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(result.result ?? result, null, 2),
							},
						],
					};
				} catch (e: any) {
					return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
				}
			},
		);

		server.tool(
			"connector_list",
			"List available connector tools from your connected services",
			{},
			async () => {
				try {
					const rpcPayload = {
						jsonrpc: "2.0",
						id: Date.now(),
						method: "tools/list",
						params: {},
					};

					const resp = await fetch(mcpConfig!.mcp_url, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${mcpConfig!.mcp_token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(rpcPayload),
					});

					const result = await resp.json();
					const tools = result.result?.tools ?? [];
					if (tools.length === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: "No connector tools available. Connect services in the Clawdi Cloud dashboard first.",
								},
							],
						};
					}
					const text = tools
						.map(
							(t: any) =>
								`${t.name}: ${t.description?.slice(0, 100) ?? "No description"}`,
						)
						.join("\n");
					return { content: [{ type: "text" as const, text }] };
				} catch (e: any) {
					return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
				}
			},
		);
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
}
