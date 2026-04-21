import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";

interface McpTool {
	name: string;
	description: string;
	parameters?: {
		properties: Record<string, any>;
		required: string[];
	};
}

export async function startMcpServer() {
	if (!isLoggedIn()) {
		process.stderr.write("Not logged in. Run `clawdi login` first.\n");
		process.exit(1);
	}

	const api = new ApiClient();

	// Get MCP proxy config — override mcp_url with local apiUrl
	const { getConfig } = await import("../lib/config");
	const cliConfig = getConfig();
	let mcpConfig: { mcp_url: string; mcp_token: string } | null = null;
	try {
		const raw = await api.get<{ mcp_url: string; mcp_token: string }>("/api/connectors/mcp-config");
		// Backend returns localhost URL which may not work in containers;
		// use the CLI's configured apiUrl instead
		raw.mcp_url = `${cliConfig.apiUrl}/api/mcp/proxy`;
		mcpConfig = raw;
	} catch {
		process.stderr.write(
			"Warning: Could not get MCP proxy config. Connector tools unavailable.\n",
		);
	}

	// Fetch available tools from backend (user's connected apps)
	let remoteTools: McpTool[] = [];
	if (mcpConfig) {
		try {
			const resp = await fetch(mcpConfig.mcp_url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${mcpConfig.mcp_token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: {},
				}),
			});
			const result = await resp.json();
			remoteTools = result.result?.tools ?? [];
			process.stderr.write(
				`Loaded ${remoteTools.length} connector tools.\n`,
			);
		} catch (e: any) {
			process.stderr.write(
				`Warning: Could not fetch connector tools: ${e.message}\n`,
			);
		}
	}

	const server = new McpServer({
		name: "clawdi-cloud",
		version: "0.0.1",
	});

	// --- Clawdi native tools ---

	server.tool(
		"memory_search",
		"ALWAYS call this BEFORE answering any question that references the user's own context — their preferences, projects, past decisions, named entities, or work history. A missed hit costs the user's trust every subsequent turn; a call that returns empty costs ~100ms. Bias toward calling. Works in any language — pass the user's query through as-is.\n\nMUST call when the user's message contains ANY of these signals (in English, Chinese, or any other language):\n- First-person self-reference in a question about themselves: possessives like \"my\", verbs of habit like \"I usually\", \"I prefer\", \"I always\"\n- Preference / habit questions, even phrased abstractly: \"what do I usually use for X\", \"how do I normally do Y\", \"what's my preferred tool for Z\" — these MUST trigger even when no specific entity is named\n- Callbacks to past context: \"like last time\", \"as I mentioned\", \"you know the one\", \"we discussed before\", \"what was that X\"\n- Named entities specific to this user: their project / repo / service / team / tool name, or a person by name\n- Any reference to a past bug, decision, investigation, meeting, or design choice\n\nExample queries to pass (choose whichever phrasing fits; language does not matter): \"user's name\", \"coding style preference\", \"command-line tools the user uses\", \"how we fixed the login bug\", \"Clerk auth decision reasoning\", \"project architecture\".\n\nDo NOT call for pure textbook / generic programming questions with zero user-specific signal (e.g. \"how does async/await work\", \"what is the time complexity of quicksort\").\n\nWhen in doubt, CALL IT. Zero results is cheap; a missed memory makes you look amnesic.",
		{
			query: z
				.string()
				.describe(
					"Natural-language query in any language — the search does semantic matching, no keyword optimization needed. Pass the user's own phrasing (translation not required) or a short rewrite that captures intent. Examples: \"user's name\", \"coding style preference\", \"command-line tools the user prefers\", \"how we fixed the login bug\", \"Clerk auth reasoning\", \"project architecture\".",
				),
			limit: z
				.number()
				.optional()
				.describe("Max results (default 10)."),
		},
		async ({ query, limit }) => {
			try {
				const results = await api.get<any[]>(
					`/api/memories?q=${encodeURIComponent(query)}&limit=${limit ?? 10}`,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: results.length
								? results
										.map(
											(m: any) =>
												`[${m.category}] ${m.content}`,
										)
										.join("\n\n")
								: "No memories found.",
						},
					],
				};
			} catch (e: any) {
				return {
					content: [
						{ type: "text" as const, text: `Error: ${e.message}` },
					],
				};
			}
		},
	);

	server.tool(
		"memory_add",
		"Store a durable memory so future agent sessions (same agent, or a different one) can retrieve this context. Call this when you learn something non-obvious about the user or their project that a future session would benefit from knowing.\n\nMUST call when:\n- The user explicitly asks you to remember something (\"remember this\", \"save this\", or equivalent in any language) — always honor the request\n- You just fixed a non-trivial bug — save ROOT CAUSE + fix, not just \"bug fixed\"\n- You and the user made an architecture decision together — save the decision AND the reasoning (why this option over alternatives)\n- The user expressed a coding / workflow preference you had to ask about — save it so you or another agent never asks again (e.g. \"user prefers pnpm over npm\")\n- The user shared personal info (their name, their project name, their team, who they work with) that future context would need\n\nDo NOT save:\n- Trivia that any agent can discover by reading the current code\n- Generic programming knowledge (how APIs work, language features)\n- Ephemeral conversation details (\"the user asked about X today\")\n\nWrite the content as a standalone sentence with full context — include proper nouns, not pronouns. A future session will read it without today's conversation. Content language should match the user's primary language for that context.",
		{
			content: z
				.string()
				.describe(
					"The memory content. Standalone sentence that makes sense in isolation. Examples: \"The user prefers rg over grep and fd over find.\", \"We chose Clerk over Auth0 because the team already had a Clerk account.\", \"The login bug on 2026-04-15 was caused by a stale JWT cache in the authentication middleware.\"",
				),
			category: z
				.enum([
					"fact",
					"preference",
					"pattern",
					"decision",
					"context",
				])
				.optional()
				.describe(
					"fact — technical facts, API details, config values. preference — user preferences, coding style, workflow choices. pattern — recurring patterns, pitfalls, team conventions. decision — architecture decisions and their reasoning. context — project context, deadlines, ongoing work. Default: fact.",
				),
		},
		async ({ content, category }) => {
			try {
				const result = await api.post<{ id: string }>(
					"/api/memories",
					{
						content,
						category: category ?? "fact",
					},
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Memory stored (${result.id.slice(0, 8)})`,
						},
					],
				};
			} catch (e: any) {
				return {
					content: [
						{ type: "text" as const, text: `Error: ${e.message}` },
					],
				};
			}
		},
	);

	// --- Dynamically registered connector tools (from Composio via backend) ---

	if (mcpConfig && remoteTools.length > 0) {
		const callTool = async (
			toolName: string,
			args: Record<string, unknown>,
		) => {
			const resp = await fetch(mcpConfig!.mcp_url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${mcpConfig!.mcp_token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: Date.now(),
					method: "tools/call",
					params: { name: toolName, arguments: args },
				}),
			});
			const result = await resp.json();
			if (result.error) {
				throw new Error(JSON.stringify(result.error));
			}
			return result.result ?? result;
		};

		for (const tool of remoteTools) {
			// Build Zod schema from Composio parameter definitions
			const schema: Record<string, z.ZodTypeAny> = {};
			if (tool.parameters?.properties) {
				for (const [key, prop] of Object.entries(tool.parameters.properties)) {
					const desc = (prop as any).description || key;
					const isRequired = tool.parameters.required?.includes(key);
					let field: z.ZodTypeAny;
					switch ((prop as any).type) {
						case "integer":
						case "number":
							field = z.number().describe(desc);
							break;
						case "boolean":
							field = z.boolean().describe(desc);
							break;
						case "array":
							field = z.array(z.any()).describe(desc);
							break;
						case "object":
							field = z.record(z.string(), z.any()).describe(desc);
							break;
						default:
							field = z.string().describe(desc);
					}
					schema[key] = isRequired ? field : field.optional();
				}
			}

			// Fallback: if no parameters, accept a generic JSON string
			const hasSchema = Object.keys(schema).length > 0;
			const toolSchema = hasSchema
				? schema
				: {
						arguments: z
							.string()
							.optional()
							.describe("JSON string of tool arguments"),
					};

			server.tool(
				tool.name.toLowerCase(),
				tool.description || tool.name,
				toolSchema,
				async (params) => {
					try {
						const args = hasSchema
							? params
							: (params as any).arguments
								? JSON.parse((params as any).arguments)
								: {};
						const result = await callTool(tool.name, args as Record<string, unknown>);
						return {
							content: [
								{
									type: "text" as const,
									text:
										typeof result === "string"
											? result
											: JSON.stringify(result, null, 2),
								},
							],
						};
					} catch (e: any) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${e.message}`,
								},
							],
						};
					}
				},
			);
		}
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
}
