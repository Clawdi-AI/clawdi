import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient, unwrap } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";

// Minimal shape of a JSON Schema property we care about when mapping
// Composio tool definitions to Zod. Unknown fields are ignored.
interface JsonSchemaProperty {
	type?: string;
	description?: string;
}

interface McpTool {
	name: string;
	description: string;
	parameters?: {
		properties: Record<string, JsonSchemaProperty>;
		required?: string[];
	};
}

interface JsonRpcResponse {
	result?: unknown;
	error?: unknown;
}

interface ToolsListResult {
	tools?: McpTool[];
}

const MEMORY_EXTRACT_INSTRUCTIONS = `Review the CURRENT conversation silently and propose up to 5 durable memories worth saving for future sessions. Pick the highest-signal. Fewer is better — a confident 1-2 beats 5 mediocre. Do not fabricate candidates to fill the list.

Dedup first, silently: for each candidate, call memory_search on its key topic and drop any that already have a clear match stored.

If nothing qualifies — either because no candidate was durable, or because every candidate was already saved — reply "nothing worth extracting" (or "everything useful is already saved") and stop.

Otherwise, present the surviving candidates to the user as a numbered list. For each: [category] full-sentence content, using proper nouns, not pronouns. Example:

  Found 3 candidate memories:
  1. [preference] The user prefers rg over grep and fd over find for searching files in their codebase.
  2. [decision] Clawdi chose Clerk for auth because the team already had a Clerk account.
  3. [pattern] All code comments in clawdi must be in English (per CLAUDE.md).

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
		process.stderr.write("Not logged in. Run `clawdi auth login` first.\n");
		process.exit(1);
	}

	const api = new ApiClient();

	// Get MCP proxy config — override mcp_url with local apiUrl
	const { getConfig } = await import("../lib/config");
	const cliConfig = getConfig();
	let mcpConfig: { mcp_url: string; mcp_token: string } | null = null;
	try {
		const raw = unwrap(await api.GET("/api/connectors/mcp-config"));
		// Backend returns localhost URL which may not work in containers;
		// use the CLI's configured apiUrl instead
		raw.mcp_url = `${cliConfig.apiUrl}/api/mcp/proxy`;
		mcpConfig = raw;
	} catch {
		process.stderr.write("Warning: Could not get MCP proxy config. Connector tools unavailable.\n");
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
			const result = (await resp.json()) as JsonRpcResponse;
			const toolsResult = (result.result ?? {}) as ToolsListResult;
			remoteTools = toolsResult.tools ?? [];
			process.stderr.write(`Loaded ${remoteTools.length} connector tools.\n`);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			process.stderr.write(`Warning: Could not fetch connector tools: ${message}\n`);
		}
	}

	const server = new McpServer({
		name: "clawdi",
		version: "0.0.1",
	});

	// --- Clawdi native tools ---

	server.tool(
		"memory_search",
		'ALWAYS call this BEFORE answering any question that references the user\'s own context — their preferences, projects, past decisions, named entities, or work history. A missed hit costs the user\'s trust every subsequent turn; a call that returns empty costs ~100ms. Bias toward calling. Works in any language — pass the user\'s query through as-is.\n\nMUST call when the user\'s message contains ANY of these signals (in English, Chinese, or any other language):\n- First-person self-reference in a question about themselves: possessives like "my", verbs of habit like "I usually", "I prefer", "I always"\n- Preference / habit questions, even phrased abstractly: "what do I usually use for X", "how do I normally do Y", "what\'s my preferred tool for Z" — these MUST trigger even when no specific entity is named\n- Callbacks to past context: "like last time", "as I mentioned", "you know the one", "we discussed before", "what was that X"\n- Named entities specific to this user: their project / repo / service / team / tool name, or a person by name\n- Any reference to a past bug, decision, investigation, meeting, or design choice\n\nExample queries to pass (choose whichever phrasing fits; language does not matter): "user\'s name", "coding style preference", "command-line tools the user uses", "how we fixed the login bug", "Clerk auth decision reasoning", "project architecture".\n\nDo NOT call for pure textbook / generic programming questions with zero user-specific signal (e.g. "how does async/await work", "what is the time complexity of quicksort").\n\nWhen in doubt, CALL IT. Zero results is cheap; a missed memory makes you look amnesic.',
		{
			query: z
				.string()
				.describe(
					'Natural-language query in any language — the search does semantic matching, no keyword optimization needed. Pass the user\'s own phrasing (translation not required) or a short rewrite that captures intent. Examples: "user\'s name", "coding style preference", "command-line tools the user prefers", "how we fixed the login bug", "Clerk auth reasoning", "project architecture".',
				),
			limit: z.number().optional().describe("Max results (default 10)."),
		},
		async ({ query, limit }) => {
			try {
				const { items: results } = unwrap(
					await api.GET("/api/memories", {
						params: { query: { q: query, page_size: limit ?? 10 } },
					}),
				);
				return {
					content: [
						{
							type: "text" as const,
							text: results.length
								? results.map((m) => `[${m.category}] ${m.content}`).join("\n\n")
								: "No memories found.",
						},
					],
				};
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
				};
			}
		},
	);

	server.tool(
		"memory_add",
		'Store a durable memory so future agent sessions (same agent, or a different one) can retrieve this context. Call this when you learn something non-obvious about the user or their project that a future session would benefit from knowing.\n\nMUST call when:\n- The user explicitly asks you to remember something ("remember this", "save this", or equivalent in any language) — always honor the request\n- You just fixed a non-trivial bug — save ROOT CAUSE + fix, not just "bug fixed"\n- You and the user made an architecture decision together — save the decision AND the reasoning (why this option over alternatives)\n- The user expressed a coding / workflow preference you had to ask about — save it so you or another agent never asks again (e.g. "user prefers pnpm over npm")\n- The user shared personal info (their name, their project name, their team, who they work with) that future context would need\n\nDo NOT save:\n- Trivia that any agent can discover by reading the current code\n- Generic programming knowledge (how APIs work, language features)\n- Ephemeral conversation details ("the user asked about X today")\n\nWrite the content as a standalone sentence with full context — include proper nouns, not pronouns. A future session will read it without today\'s conversation. Content language should match the user\'s primary language for that context.',
		{
			content: z
				.string()
				.describe(
					'The memory content. Standalone sentence that makes sense in isolation. Examples: "The user prefers rg over grep and fd over find.", "We chose Clerk over Auth0 because the team already had a Clerk account.", "The login bug on 2026-04-15 was caused by a stale JWT cache in the authentication middleware."',
				),
			category: z
				.enum(["fact", "preference", "pattern", "decision", "context"])
				.optional()
				.describe(
					"fact — technical facts, API details, config values. preference — user preferences, coding style, workflow choices. pattern — recurring patterns, pitfalls, team conventions. decision — architecture decisions and their reasoning. context — project context, deadlines, ongoing work. Default: fact.",
				),
		},
		async ({ content, category }) => {
			try {
				const result = unwrap(
					await api.POST("/api/memories", {
						body: { content, category: category ?? "fact", source: "mcp" },
					}),
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Memory stored (${result.id.slice(0, 8)})`,
						},
					],
				};
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
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

	// --- Session tools ---
	//
	// Three-tier recall hierarchy. Agents should default to
	// `memory_search` (cheap, distilled facts). When the user asks
	// about a SPECIFIC past conversation (not just "what do I know
	// about X" but "what happened in the deploy session last
	// Friday"), reach for these:
	//
	//   session_search  → find session ids matching topic / text
	//   session_summary → cheap metadata + summary (no message body)
	//   session_get     → read messages from a specific session id
	//
	// Order of operations: search → summary → get. `get` ships the
	// raw conversation transcript and is the most expensive — only
	// use it after you've narrowed via search/summary.

	server.tool(
		"session_search",
		'Search past sessions (full conversation transcripts the user has had with any agent — Claude Code, Codex, Hermes, OpenClaw — synced through clawdi). Returns matching session ids with metadata. Use this when the user references a SPECIFIC past conversation by topic, not when asking about general preferences (use memory_search for that).\n\nWHEN TO CALL:\n- "what did we discuss in the X session" / "remember when we worked on Y"\n- "show me the conversation where we fixed the auth bug"\n- "find that session about the migration"\n- The user references work from a specific past project / day / topic and memory_search came up empty\n\nWHEN NOT TO CALL:\n- General preference / habit questions ("what tools do I use") → memory_search\n- Questions about the current code state (read the code instead)\n- Generic programming questions\n\nOrder of operations: session_search → session_summary (cheap, no message body) → session_get (full transcript, expensive). Never jump straight to session_get unless you already have the session id.',
		{
			query: z
				.string()
				.describe(
					'Free-text query. Searches summary, project_path, and local_session_id (case-insensitive partial match). Examples: "deploy", "auth bug", "session-ux-overhaul", "PR #71".',
				),
			limit: z.number().optional().describe("Max results (default 10, max 50)."),
			agent: z
				.enum(["claude_code", "codex", "openclaw", "hermes"])
				.optional()
				.describe("Filter to one agent type. Omit to search across all the user's agents."),
		},
		async ({ query, limit, agent }) => {
			try {
				const { items, total } = unwrap(
					await api.GET("/api/sessions", {
						params: {
							query: {
								q: query,
								page_size: Math.min(limit ?? 10, 50),
								agent,
							},
						},
					}),
				);
				if (items.length === 0)
					return { content: [{ type: "text" as const, text: "No matching sessions." }] };
				const lines = items.map((s) => {
					const summary = s.summary?.replace(/\s+/g, " ").slice(0, 120) ?? s.local_session_id;
					const project = s.project_path?.split("/").pop() ?? "";
					const agentTag = s.agent_type ? `[${s.agent_type}]` : "";
					return `- ${s.id} ${agentTag} ${summary}${project ? ` · ${project}` : ""} · ${s.last_activity_at}`;
				});
				const more =
					items.length < total
						? `\n\n(${items.length}/${total} shown — refine query to narrow.)`
						: "";
				return {
					content: [
						{
							type: "text" as const,
							text: `Sessions matching "${query}":\n${lines.join("\n")}${more}`,
						},
					],
				};
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
			}
		},
	);

	server.tool(
		"session_summary",
		"Get cheap metadata + summary for a specific session id (no message body). Use after `session_search` to confirm you've got the right session before paying for `session_get`. Returns: agent, machine, project, started/last-activity timestamps, message_count, total tokens, model, status, and the auto-generated summary line.",
		{
			session_id: z
				.string()
				.describe(
					'UUID of the session, as returned by `session_search`. Format: "01234567-89ab-cdef-0123-456789abcdef".',
				),
		},
		async ({ session_id }) => {
			try {
				const s = unwrap(
					await api.GET("/api/sessions/{session_id}", {
						params: { path: { session_id } },
					}),
				);
				const tokens = s.input_tokens + s.output_tokens;
				const lines = [
					`session_id: ${s.id}`,
					`agent: ${s.agent_type ?? "(unknown)"}${s.machine_name ? ` · ${s.machine_name}` : ""}`,
					s.project_path ? `project: ${s.project_path}` : null,
					`started: ${s.started_at}`,
					`last_activity: ${s.last_activity_at}`,
					`messages: ${s.message_count}`,
					`tokens: ${tokens.toLocaleString()} (in: ${s.input_tokens}, out: ${s.output_tokens})`,
					s.model ? `model: ${s.model}` : null,
					`status: ${s.status}`,
					s.summary ? `\nsummary: ${s.summary}` : null,
				].filter((x): x is string => x !== null);
				return { content: [{ type: "text" as const, text: lines.join("\n") }] };
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
			}
		},
	);

	server.tool(
		"session_get",
		"Read the actual messages from a specific past session. EXPENSIVE — full conversation transcripts can be 10+ MB on long sessions, and the agent then reads every word. Use sparingly: prefer `session_search` + `session_summary` for narrowing, only call `session_get` once you've decided you need the full text. Pagination: 100 messages per call. For long sessions, call repeatedly bumping `offset` until you've covered what you need.",
		{
			session_id: z
				.string()
				.describe("UUID of the session, as returned by `session_search` or `session_summary`."),
			offset: z
				.number()
				.optional()
				.describe(
					"Index to start from (default 0 = first / oldest message). Bump by `limit` to paginate.",
				),
			limit: z.number().optional().describe("Max messages to return (default 100, max 500)."),
		},
		async ({ session_id, offset, limit }) => {
			try {
				const page = unwrap(
					await api.GET("/api/sessions/{session_id}/messages", {
						params: {
							path: { session_id },
							query: { offset: offset ?? 0, limit: Math.min(limit ?? 100, 500) },
						},
					}),
				);
				if (page.items.length === 0) {
					return { content: [{ type: "text" as const, text: "(no messages)" }] };
				}
				const lines = page.items.map((m) => {
					const ts = m.timestamp ? `[${m.timestamp}] ` : "";
					return `${ts}${m.role}: ${m.content}`;
				});
				const cursor =
					page.offset + page.items.length < page.total
						? `\n\n(loaded ${page.offset + page.items.length}/${page.total} — call again with offset=${page.offset + page.items.length} for more.)`
						: "";
				return {
					content: [{ type: "text" as const, text: lines.join("\n\n") + cursor }],
				};
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
			}
		},
	);

	// --- Dynamically registered connector tools (from Composio via backend) ---

	if (mcpConfig && remoteTools.length > 0) {
		const { mcp_url: proxyUrl, mcp_token: proxyToken } = mcpConfig;
		const callTool = async (toolName: string, args: Record<string, unknown>) => {
			const resp = await fetch(proxyUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${proxyToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: Date.now(),
					method: "tools/call",
					params: { name: toolName, arguments: args },
				}),
			});
			const result = (await resp.json()) as JsonRpcResponse;
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
					const desc = prop.description || key;
					const isRequired = tool.parameters.required?.includes(key) ?? false;
					let field: z.ZodTypeAny;
					switch (prop.type) {
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
						arguments: z.string().optional().describe("JSON string of tool arguments"),
					};

			server.tool(
				tool.name.toLowerCase(),
				tool.description || tool.name,
				toolSchema,
				async (params: Record<string, unknown>) => {
					try {
						let args: Record<string, unknown>;
						if (hasSchema) {
							args = params;
						} else {
							const argsField = params.arguments;
							args =
								typeof argsField === "string" && argsField.length > 0
									? (JSON.parse(argsField) as Record<string, unknown>)
									: {};
						}
						const result = await callTool(tool.name, args);
						return {
							content: [
								{
									type: "text" as const,
									text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
								},
							],
						};
					} catch (e: unknown) {
						const message = e instanceof Error ? e.message : String(e);
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${message}`,
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
