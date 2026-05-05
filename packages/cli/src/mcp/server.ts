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
		'Look up ATOMIC FACTS about the user: a specific value (URL, key name, config setting), a habit/preference one-liner ("I usually X"), or a single past decision. Memory is the right tool when the user wants ONE fact, not the whole picture about an entity.\n\nFOR ENTITY OVERVIEWS — "what do I have about X", "tell me about my Y", "give me the status of Z" — prefer wiki_search instead. The wiki returns a synthesized 1-paragraph summary aggregating evidence from all of memory + skills + sessions + vault for that entity. One read beats stitching together 5 memory fragments.\n\nWORK IN TIERS. Don\'t reflexively call this on every turn:\n- Tier 0: try local context first (current conversation, files in CWD, your training)\n- Tier 1: if local doesn\'t suffice, pick by question shape (this tool for atomic facts, wiki_search for entity overviews, skill_search for "how do I X")\n- Tier 2: escalate to clawdi_search when domain is unclear or Tier 1 is empty\n\nWORKS IN ANY LANGUAGE — pass the user\'s query through as-is.\n\nCALL THIS when the user\'s message asks for a SPECIFIC fact / value / preference:\n- "what\'s my X" where X is a concrete value (email, API endpoint, deploy target)\n- "I usually X" / "I prefer X" / habit lookups\n- "how did we fix the login bug" / past-decision recall with no obvious entity name\n- Free-form recall where you don\'t know which entity to wiki on\n\nDO NOT call:\n- For pure textbook / generic programming questions ("how does async/await work")\n- When the answer is already in the current conversation context\n- For broad "tell me about X" questions — use wiki_search\n\nA call that returns empty costs ~100ms; missing the user\'s context costs trust. When unsure between memory and wiki for a user-context question: bias toward calling at least one.',
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

	// --- Cross-domain tools: skills, sessions, vault, unified search ---

	server.tool(
		"clawdi_search",
		'CROSS-DOMAIN UMBRELLA — fan-out across wiki + memory + skills + sessions + vault in one call. Use this as a TIER 2 escalation, not a Tier 1 default.\n\nWORK IN TIERS:\n- Tier 0: try local context first (current conversation, files, your training)\n- Tier 1: pick a single domain by question shape — wiki_search for "tell me about my X" / entities, memory_search for atomic facts, skill_search for "how do I X", session_search for past work\n- Tier 2: call THIS tool when Tier 1 returns empty/weak, OR when you genuinely cannot tell which single domain owns the answer\n\nCALL THIS when:\n- A Tier 1 search returned empty and you want a broader sweep before declaring zero-result\n- The user references something where the domain is genuinely ambiguous: "the one I set up" with no other signal, vague callbacks like "like last time" without an entity\n- Cross-cutting: "what do I have for X" where the intent could legitimately span multiple domains\n\nReturns mixed-type results. Each has type (wiki/memory/skill/session/vault), id, title, and href. After getting results, READ the relevant items via the domain\'s get tool (wiki_get, skill_get, session_get, memory_search) for full content. CITE the IDs in your response — do not paraphrase results away.\n\nDO NOT call:\n- For purely textbook programming questions\n- When the user\'s intent is unambiguously a single domain — call that domain\'s tool directly (cheaper, more specific results)\n- As a first move when the question shape clearly fits one tool (e.g. "tell me about my X" is wiki_search, not clawdi_search)',
		{
			query: z.string().describe("Natural-language query in any language."),
			limit: z.number().optional().describe("Max results per domain (default 5)."),
		},
		async ({ query, limit }) => {
			try {
				const data = await api.get<{
					query: string;
					results: Array<{
						type: string;
						id: string;
						title: string;
						subtitle: string | null;
						href: string;
					}>;
				}>(`/api/search?q=${encodeURIComponent(query)}`);
				if (!data.results.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: "No results across memory, skills, sessions, or vault. (Empty result is real — say so to the user instead of falling back to general knowledge.)",
							},
						],
					};
				}
				const byType: Record<string, typeof data.results> = {};
				for (const hit of data.results) {
					const bucket = byType[hit.type] ?? [];
					bucket.push(hit);
					byType[hit.type] = bucket;
				}
				const cap = limit ?? 5;
				const lines: string[] = [];
				for (const [type, hits] of Object.entries(byType)) {
					lines.push(`## ${type} (${hits.length})`);
					for (const h of hits.slice(0, cap)) {
						const sub = h.subtitle ? ` — ${h.subtitle}` : "";
						lines.push(`  [${h.id}] ${h.title}${sub}`);
					}
				}
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
				};
			} catch (e: any) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e.message}` }],
				};
			}
		},
	);

	server.tool(
		"skill_search",
		'ALWAYS call this BEFORE writing custom code or suggesting a manual approach for any task that might already be a skill. The user has many skills (often 100+) covering deploy, QA, browser automation, voice/SMS, social posting, prediction markets, code review, and more. Skill descriptions are explicit about when to use them — let the search find the right one.\n\nMUST call when the user\'s request matches ANY of these patterns:\n- "How do I X" / "how can I X" / "show me how to X" — a skill very likely exists\n- Action verbs that map to common workflows: deploy, ship, test, QA, review, browse, post, message, send, search, find, fetch, analyze, draft, summarize\n- Named external services: Twitter, Slack, Notion, Stripe, Polymarket, GitHub, iMessage, Apple Notes/Reminders/FindMy\n- Delegation requests: "delegate this to claude-code / codex / hermes" — those are skills\n- Workflow steps: "investigate this bug", "review the plan", "do a retro"\n\nReturns ranked skills (key, name, description, version). After finding the right one, call skill_get(key) to load the full instructions before executing.\n\nDo NOT call for trivial code questions, agent self-questions, or when the user has just told you not to use a skill.\n\nFailure mode if skipped: you write a worse, ad-hoc version of something the user has already built and refined. Cite the skill key when you use one.',
		{
			query: z.string().describe("Natural-language query — what the user wants to do."),
			category: z
				.string()
				.optional()
				.describe(
					'Filter by top-level category (e.g. "gstack", "mlops", "apple", "research", "github").',
				),
			limit: z.number().optional().describe("Max results (default 5)."),
		},
		async ({ query, category, limit }) => {
			try {
				const params = new URLSearchParams({
					q: query,
					page_size: String(limit ?? 5),
				});
				const data = await api.get<{
					items: Array<{
						skill_key: string;
						name: string;
						description: string;
						version: number;
					}>;
					total: number;
				}>(`/api/skills?${params.toString()}`);
				let items = data.items;
				if (category) {
					items = items.filter((s) => s.skill_key.startsWith(`${category}/`));
				}
				if (!items.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No skills matched "${query}"${category ? ` in category "${category}"` : ""}.`,
							},
						],
					};
				}
				const lines = items.map(
					(s) => `[${s.skill_key}] ${s.name} (v${s.version}) — ${s.description}`,
				);
				return {
					content: [{ type: "text" as const, text: lines.join("\n\n") }],
				};
			} catch (e: any) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e.message}` }],
				};
			}
		},
	);

	server.tool(
		"skill_get",
		"Call after skill_search to load the full skill instructions before executing. The search returns descriptions only; the body has the actual procedure, tool calls, and constraints.\n\nMUST call before invoking any procedure that depends on a skill — never wing it from the description alone.\n\nReturns the full SKILL.md content (frontmatter + body). Read it once at the start of the task; you don't need to re-load on every step.\n\nFailure mode if skipped: you execute based on the 150-character description and miss critical details (auth setup, ordering, edge cases) that are in the body.",
		{
			skill_key: z
				.string()
				.describe('Skill key, e.g. "research/polymarket", "gstack/qa", "apple/imessage".'),
		},
		async ({ skill_key }) => {
			try {
				// Backend's /api/skills/{skill_key} currently 404s for skill_keys
				// containing "/" — fall through the list endpoint with include_content
				// and match by exact skill_key. Switch to the direct GET when backend
				// fixes routing for slash-bearing keys.
				const params = new URLSearchParams({
					q: skill_key.split("/").pop() ?? skill_key,
					include_content: "true",
					page_size: "20",
				});
				const data = await api.get<{
					items: Array<{
						skill_key: string;
						name: string;
						description: string;
						content?: string;
					}>;
				}>(`/api/skills?${params.toString()}`);
				const match = data.items.find((s) => s.skill_key === skill_key);
				if (!match) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Skill "${skill_key}" not found.${
									data.items.length
										? ` Did you mean: ${data.items
												.slice(0, 3)
												.map((s) => s.skill_key)
												.join(", ")}?`
										: ""
								}`,
							},
						],
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: match.content ?? "(skill body not available — backend did not return content)",
						},
					],
				};
			} catch (e: any) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e.message}` }],
				};
			}
		},
	);

	server.tool(
		"session_search",
		'Call when the user references prior conversation work — "what did I figure out", "where did we leave off", "what was that thing about X". Searches summary across all your past sessions on Clawdi (across every agent: Claude Code, Codex, OpenClaw, Hermes).\n\nMUST call when:\n- "What did I/we do/figure out about X" — past-tense recall\n- "Continue from where we left off" / "pick up where we stopped"\n- "Show me that conversation about X"\n- "Last week / last month, when I was working on X"\n\nReturns sessions ranked by relevance (id, agent_type, started_at, summary). After finding the right session, call session_get(id) only if the summary isn\'t enough.\n\nDo NOT call for the current session — you can already see that.\n\nFailure mode if skipped: you re-derive a decision the user already made, or re-do investigation work that\'s already done. Wasted effort + looks amnesic.',
		{
			query: z.string().describe("Natural-language query."),
			agent: z
				.enum(["claude_code", "codex", "openclaw", "hermes"])
				.optional()
				.describe("Filter to one agent."),
			since: z
				.string()
				.optional()
				.describe('ISO date — limit to recent sessions, e.g. "2026-04-01".'),
			limit: z.number().optional().describe("Max results (default 5)."),
		},
		async ({ query, agent, since, limit }) => {
			try {
				const params = new URLSearchParams({
					q: query,
					page_size: String(limit ?? 5),
				});
				if (agent) params.set("agent", agent);
				if (since) params.set("since", since);
				const data = await api.get<{
					items: Array<{
						id: string;
						agent_type: string;
						summary: string | null;
						started_at: string;
						message_count: number;
					}>;
					total: number;
				}>(`/api/sessions?${params.toString()}`);
				if (!data.items.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No sessions matched "${query}". (Backend currently uses substring match — try a single keyword. Note: many session summaries are still being re-distilled; recall quality will improve.)`,
							},
						],
					};
				}
				const lines = data.items.map((s) => {
					const date = s.started_at.slice(0, 10);
					const summary = (s.summary ?? "(no summary)").slice(0, 200);
					return `[${s.id.slice(0, 8)}] ${date} ${s.agent_type} (${s.message_count} msg) — ${summary}`;
				});
				return {
					content: [{ type: "text" as const, text: lines.join("\n\n") }],
				};
			} catch (e: any) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e.message}` }],
				};
			}
		},
	);

	server.tool(
		"session_get",
		"Call after session_search if the summary isn't enough and you need the full message-by-message transcript. Expensive — sessions can be 100+ messages. Use sparingly.\n\nMUST call only when the user explicitly asks \"show me the full session\" or when the summary genuinely doesn't contain the detail you need (e.g. you need an exact code snippet they wrote).\n\nPrefer session summary first. If that's enough, do NOT call this.\n\nFailure mode if over-called: blows context budget on transcript noise.",
		{
			session_id: z.string().describe("UUID from session_search."),
		},
		async ({ session_id }) => {
			try {
				const messages = await api.get<
					Array<{
						role: string;
						content: string | Array<Record<string, unknown>>;
						created_at?: string;
					}>
				>(`/api/sessions/${session_id}/content`);
				if (!messages.length) {
					return {
						content: [{ type: "text" as const, text: "(no messages)" }],
					};
				}
				// `content` may be a string (legacy / hermes) or a block list
				// (claude_code / codex / openclaw with tool calls). Render
				// blocks as a one-line marker per type so the MCP transcript
				// view shows tool usage without dumping huge tool_result bodies.
				const renderContent = (c: string | Array<Record<string, unknown>>): string => {
					if (typeof c === "string") return c.slice(0, 1000);
					return c
						.map((b) => {
							const t = b.type;
							if (t === "text" && typeof b.text === "string") {
								return (b.text as string).slice(0, 1000);
							}
							if (t === "tool_use") {
								return `[tool_use ${b.name ?? "?"}]`;
							}
							if (t === "tool_result") {
								const out = typeof b.content === "string" ? b.content : "";
								return `[tool_result] ${out.slice(0, 200)}`;
							}
							if (t === "thinking") return "[thinking]";
							return `[${t ?? "block"}]`;
						})
						.join(" ");
				};
				const lines = messages.map((m) => {
					const ts = m.created_at?.slice(11, 19) ?? "";
					return `[${m.role}${ts ? ` ${ts}` : ""}] ${renderContent(m.content)}`;
				});
				return {
					content: [{ type: "text" as const, text: lines.join("\n\n") }],
				};
			} catch (e: any) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e.message}` }],
				};
			}
		},
	);

	server.tool(
		"vault_list",
		'Surface the NAMES of credentials/secrets the user has stored in their vault. Returns key names only — VALUES ARE NEVER EXPOSED through this tool. Use this to suggest "I see you have X configured, want me to use it?" instead of asking "do you have X?".\n\nMUST call when the user mentions a service that needs credentials and you don\'t already have explicit values:\n- "deploy X" — likely needs deploy keys, check the relevant scope\n- "post to Twitter / Slack / Discord" — check for those tokens\n- "use my Stripe / Notion / GitHub" — check for the keys\n- Any reference to a service the user runs (Eliza agents, OpenClaw deployments, etc.)\n\nReturns scope groupings or per-scope key names. NEVER value, never partial value, never hint at value beyond name.\n\nSECURITY RULE: if the user asks "what\'s the value of X" or "show me my secret" — refuse, surface the name only, and tell them to retrieve from the dashboard. Do not retrieve via any other tool. This is a hard line.\n\nFailure mode if skipped: you ask the user for credentials they already have stored. Annoying and looks like you can\'t see what\'s right there.',
		{
			scope: z
				.string()
				.optional()
				.describe(
					'Filter to one app/scope, e.g. "clawdi-backend", "openclaw-voice-agent". Omit to list all scopes.',
				),
			q: z.string().optional().describe("Substring filter on scope or key name."),
		},
		async ({ scope, q }) => {
			try {
				if (scope) {
					const data = await api.get<{
						items: Array<{ name: string }>;
						slug?: string;
					}>(`/api/vault/${encodeURIComponent(scope)}/items`);
					let items = data.items ?? [];
					if (q) {
						items = items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
					}
					if (!items.length) {
						return {
							content: [
								{
									type: "text" as const,
									text: `No keys in scope "${scope}"${q ? ` matching "${q}"` : ""}.`,
								},
							],
						};
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `${scope}:\n${items.map((i) => `  - ${i.name}`).join("\n")}\n\n(values not shown — fetch from dashboard if needed)`,
							},
						],
					};
				}
				const params = new URLSearchParams({ page_size: "100" });
				if (q) params.set("q", q);
				const data = await api.get<{
					items: Array<{
						slug: string;
						name?: string;
						item_count?: number;
					}>;
					total: number;
				}>(`/api/vault?${params.toString()}`);
				if (!data.items.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No vault scopes${q ? ` matching "${q}"` : ""}.`,
							},
						],
					};
				}
				const lines = data.items.map(
					(s) => `${s.slug}${s.item_count != null ? ` (${s.item_count} keys)` : ""}`,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Scopes:\n${lines.join("\n")}\n\nCall vault_list({scope: "<slug>"}) to see key names in a scope.`,
						},
					],
				};
			} catch (e: any) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e.message}` }],
				};
			}
		},
	);

	// --- Wiki tools: synthesized entity pages aggregated across all 4 domains ---

	server.tool(
		"wiki_search",
		'FIRST-CHOICE tool for ENTITY-SHAPED questions about the user\'s world. Search the user\'s personal wiki for synthesized pages — one per real-world thing in their life (a project, tool, service, person, concept), aggregating evidence from memory + skills + sessions + vault into a 1-paragraph compiled_truth.\n\nWORK IN TIERS. Don\'t reflexively call this on every turn:\n- Tier 0: try local context first (current conversation, files in CWD, your training)\n- Tier 1: if local doesn\'t suffice, this tool is the default for entity / overview questions\n- Tier 2: escalate to clawdi_search when domain is unclear or Tier 1 is empty\n\nCALL THIS FIRST when the user\'s message has an ENTITY/OVERVIEW shape:\n- "what do I know about X" / "what do I have about X"\n- "tell me about my/our X"\n- "give me an overview / status of X"\n- A named thing the user controls — project, tool, service, person, brand\n- Anywhere you\'d otherwise have to read 5+ memory fragments and stitch them together\n\nWiki pages are LLM-synthesized — much higher signal than raw memory fragments. ONE wiki read replaces multiple memory_search calls.\n\nReturns ranked pages: {slug, title, kind, source_count, last_synthesis_at}. Then call wiki_get(slug) to read the compiled_truth and source links.\n\nDO NOT call for atomic factual lookups ("what\'s THE API endpoint URL", "what\'s my email") — memory_search is faster for one-line facts. Wiki is for the WHOLE PICTURE on a named thing.\n\nFailure mode if skipped: you read 7 noisy memory fragments and paraphrase them, when one synthesized page would have answered cleanly.',
		{
			query: z.string().describe("Natural-language query — entity name or topic."),
			limit: z.number().optional().describe("Max results (default 10)."),
		},
		async ({ query, limit }) => {
			try {
				// Server-side FTS via `q` param. The previous version fetched
				// the first N pages without query, then filtered client-side
				// — which silently returned empty whenever the matching pages
				// weren't in the recency-sorted first-N slice (very likely
				// for any specific entity name).
				const params = new URLSearchParams({
					q: query,
					page_size: String(limit ?? 10),
				});
				const data = await api.get<{
					items: Array<{
						slug: string;
						title: string;
						kind: string;
						source_count: number;
						stale: boolean;
						last_synthesis_at: string | null;
					}>;
					total: number;
				}>(`/api/wiki/pages?${params.toString()}`);
				if (!data.items?.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No wiki pages matched "${query}". (The wiki may still be empty if this user just synced — pages are auto-generated by the synthesis pipeline.)`,
							},
						],
					};
				}
				const lines = data.items.map((p) => {
					const stale = p.stale ? " [STALE]" : "";
					const synthesized = p.last_synthesis_at ? "" : " [no synthesis yet]";
					return `[${p.slug}] ${p.title} (${p.kind}, ${p.source_count} sources${stale}${synthesized})`;
				});
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
				};
			} catch (e: any) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e.message}` }],
				};
			}
		},
	);

	server.tool(
		"wiki_get",
		"Load the full content of a wiki page: compiled_truth (LLM-synthesized 'what we know about this entity'), source links grouped by domain, related pages, and backlinks. Pass the slug from wiki_search.\n\nMUST call after wiki_search to get the actual synthesized text. Without this, you only have titles.\n\nReturns: compiled_truth paragraph(s), source links (each labeled by domain: memory/skill/session/vault), related pages (graph edges), backlinks (incoming references).\n\nIf the page exists but has no compiled_truth, the synthesis pipeline hasn't run yet — fall back to reading the listed sources via memory_search / skill_get / session_search.",
		{
			slug: z.string().describe('Page slug, e.g. "polymarket", "twilio-voice-agent".'),
		},
		async ({ slug }) => {
			try {
				const data = await api.get<{
					slug: string;
					title: string;
					kind: string;
					compiled_truth: string | null;
					source_count: number;
					stale: boolean;
					last_synthesis_at: string | null;
					outgoing_links: Array<{
						link_type: string;
						to_page_id: string | null;
						to_page_slug: string | null;
						to_page_title: string | null;
						source_type: string | null;
						source_ref: string | null;
					}>;
					backlinks: Array<{ to_page_slug: string | null; to_page_title: string | null }>;
				}>(`/api/wiki/pages/${encodeURIComponent(slug)}`);

				const lines: string[] = [
					`# ${data.title}`,
					`slug: ${data.slug}  ·  kind: ${data.kind}  ·  ${data.source_count} sources` +
						(data.stale ? "  ·  STALE" : "") +
						(data.last_synthesis_at ? "" : "  ·  not yet synthesized"),
					"",
				];

				if (data.compiled_truth) {
					lines.push("## Compiled truth\n");
					lines.push(data.compiled_truth);
					lines.push("");
				} else {
					lines.push("## Compiled truth\n\n(not yet synthesized — read sources below directly)");
				}

				const sources = data.outgoing_links.filter((l) => l.source_type);
				if (sources.length > 0) {
					const byType: Record<string, string[]> = {};
					for (const l of sources) {
						if (!l.source_type) continue;
						const t = l.source_type;
						const bucket = byType[t] ?? [];
						bucket.push(l.source_ref ?? "(unknown)");
						byType[t] = bucket;
					}
					lines.push("## Sources");
					for (const [type, refs] of Object.entries(byType)) {
						lines.push(`  ${type} (${refs.length}): ${refs.join(", ")}`);
					}
					lines.push("");
				}

				const related = data.outgoing_links.filter((l) => l.to_page_id !== null && l.to_page_slug);
				if (related.length > 0) {
					lines.push("## Related pages");
					for (const l of related) {
						lines.push(`  → ${l.to_page_slug} (${l.link_type})`);
					}
					lines.push("");
				}

				if (data.backlinks.length > 0) {
					lines.push("## Backlinks");
					for (const b of data.backlinks) {
						lines.push(`  ← ${b.to_page_slug} — ${b.to_page_title}`);
					}
				}

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
				};
			} catch (e: any) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e.message}` }],
				};
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
