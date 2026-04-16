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
	const server = new McpServer({
		name: "clawdi-cloud",
		version: "0.0.1",
	});

	// Memory tools
	server.tool(
		"memory_search",
		"Search memories across all your agents",
		{ query: { type: "string", description: "Search query" }, limit: { type: "number", description: "Max results (default 10)" } },
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
			category: { type: "string", description: "Category: fact, preference, pattern, decision, context" },
			tags: { type: "string", description: "Comma-separated tags" },
		},
		async ({ content, category, tags }) => {
			try {
				const result = await api.post<{ id: string }>("/api/memories", {
					content,
					category: category ?? "fact",
					tags: tags ? (tags as string).split(",").map((t: string) => t.trim()) : undefined,
				});
				return {
					content: [{ type: "text" as const, text: `Memory stored (${result.id.slice(0, 8)})` }],
				};
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
			}
		},
	);

	server.tool(
		"vault_list",
		"List available vault keys (no values shown)",
		{},
		async () => {
			try {
				const vaults = await api.get<any[]>("/api/vault");
				if (vaults.length === 0) {
					return { content: [{ type: "text" as const, text: "No vaults configured." }] };
				}

				const lines: string[] = [];
				for (const v of vaults) {
					const items = await api.get<Record<string, string[]>>(`/api/vault/${v.slug}/items`);
					lines.push(`Vault: ${v.slug}`);
					for (const [section, fields] of Object.entries(items)) {
						for (const field of fields) {
							const display = section === "(default)" ? field : `${section}/${field}`;
							lines.push(`  ${display}`);
						}
					}
				}
				return { content: [{ type: "text" as const, text: lines.join("\n") }] };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
			}
		},
	);

	server.tool(
		"skills_list",
		"List installed skills",
		{},
		async () => {
			try {
				const skills = await api.get<any[]>("/api/skills");
				if (skills.length === 0) {
					return { content: [{ type: "text" as const, text: "No skills installed." }] };
				}
				const text = skills
					.map((s: any) => `${s.skill_key} v${s.version} (${s.source})`)
					.join("\n");
				return { content: [{ type: "text" as const, text }] };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
			}
		},
	);

	// Start stdio transport
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
