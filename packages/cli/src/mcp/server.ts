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

const MEMORY_EXTRACT_INSTRUCTIONS = `Review the CURRENT conversation silently and propose up to 5 durable memories worth saving for future sessions. Pick the highest-signal. Fewer is better — a confident 1-2 beats 5 mediocre. Do not fabricate candidates to fill the list.

Dedup first, silently: for each candidate, call memory_search on its key topic and drop any that already have a clear match stored.

If nothing qualifies — either because no candidate was durable, or because every candidate was already saved — reply "nothing worth extracting" (or "everything useful is already saved") and stop.

Otherwise, present the surviving candidates to the user as a numbered list. For each: [category] full-sentence content, using proper nouns, not pronouns. Example:

  Found 3 candidate memories:
  1. [preference] The user prefers rg over grep and fd over find for searching files in their codebase.
  2. [decision] Clawdi chose Clerk for auth because the team already had a Clerk account.
  3. [pattern] All code comments in clawdi-cloud must be in English (per CLAUDE.md).

  Save all? Or pick (e.g. "save 1 and 3", "edit 2 to say ...", "cancel").

Wait for the user's reply. Do NOT call memory_add yet.

On approval, call memory_add once per approved memory, using the category and content from the candidate (with any edits the user asked for). Then print a bullet summary with the stored IDs so the user can delete individual ones later:

  Saved:
  - [preference] abc12345 — The user prefers rg over grep...
  - [pattern]    def67890 — All code comments must be in English.

Do NOT narrate your internal workflow to the user ("running dedup", "moving to present", "STEP 1"). The user should see only the candidate list, their own reply, and the final save summary — nothing else.

What qualifies as durable:
- User preferences / habits (tools, style, workflow)
- Architecture / design decisions and their reasoning
- Recurring patterns, team conventions, pitfalls worked through
- Named entities specific to the user: project, repo, service, teammate, tool they named
- Anything the user explicitly asked you to remember

Does NOT qualify:
- One-off debugging details with no broader lesson
- Code snippets (unless they demonstrate a preferred pattern)
- Anything readable from the current code state
- Conversational noise or meta-commentary`;

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

	server.tool(
		"memory_extract",
		"Propose durable long-term memories from the CURRENT conversation, list them to the user, and save only what they approve. Call this when the user asks to 'extract memories', 'save what we discussed', 'remember this conversation', or any equivalent phrasing (in any language). The tool returns instructions — follow them exactly: list up to 5 candidates first, wait for the user's confirmation, then call memory_add on the approved ones. Do not narrate your internal workflow. This tool inspects your active conversation context — it does NOT read any external file or database.",
		{},
		async () => ({
			content: [{ type: "text" as const, text: MEMORY_EXTRACT_INSTRUCTIONS }],
		}),
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
