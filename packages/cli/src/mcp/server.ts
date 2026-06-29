import { findLikelySecret, formatSecretMemoryWarning } from "@clawdi/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v3";
import { ApiClient, unwrap } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";

// Minimal shape of a JSON Schema property we care about when mapping
// Composio tool definitions to Zod. Unknown fields are ignored.
interface JsonSchemaProperty {
	type?: string | string[];
	description?: string;
	enum?: unknown[];
	items?: JsonSchemaProperty;
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
	additionalProperties?: boolean | JsonSchemaProperty;
}

type JsonSchemaObject = JsonSchemaProperty;

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: JsonSchemaObject;
	parameters?: JsonSchemaObject;
}

type ConnectorToolCaller = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
type NativeToolInputShape = Record<string, z.ZodTypeAny>;
type NativeToolHandler = (
	params: Record<string, unknown>,
) => CallToolResult | Promise<CallToolResult>;
interface NativeToolRegistrar {
	registerTool(
		name: string,
		config: { description?: string; inputSchema?: NativeToolInputShape },
		handler: (params: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>,
	): unknown;
}

const MEMORY_CATEGORIES = ["fact", "preference", "pattern", "decision", "context"] as const;
type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumberParam(params: Record<string, unknown>, key: string): number | undefined {
	const value = params[key];
	return typeof value === "number" ? value : undefined;
}

function requiredStringParam(params: Record<string, unknown>, key: string): string | null {
	const value = params[key];
	return typeof value === "string" ? value : null;
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
	return typeof value === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

function registerNativeTool(
	server: McpServer,
	name: string,
	description: string,
	inputSchema: NativeToolInputShape,
	handler: NativeToolHandler,
) {
	const registerTool = server.registerTool.bind(server) as NativeToolRegistrar["registerTool"];
	registerTool(name, { description, inputSchema }, (params) =>
		handler(isRecord(params) ? params : {}),
	);
}

export function normalizeMcpUrl(rawUrl: string, apiUrl: string): string {
	const url = new URL(rawUrl);
	const api = new URL(apiUrl);

	if (["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname)) {
		url.protocol = api.protocol;
		url.hostname = api.hostname;
		url.port = api.port;
	}

	return url.toString();
}

function jsonSchemaType(schema: JsonSchemaProperty): string {
	if (Array.isArray(schema.type)) {
		return schema.type.find((type) => type !== "null") ?? "string";
	}
	if (schema.type) return schema.type;
	if (schema.properties || schema.additionalProperties) return "object";
	if (schema.items) return "array";
	return "string";
}

function jsonSchemaAllowsNull(schema: JsonSchemaProperty): boolean {
	return Array.isArray(schema.type) && schema.type.includes("null");
}

function stringEnumToZod(values: string[]): z.ZodTypeAny | null {
	const [first, ...rest] = values;
	if (first === undefined) return null;
	return z.enum([first, ...rest]);
}

function jsonSchemaPropertyToZod(
	schema: JsonSchemaProperty,
	fallbackDescription: string,
): z.ZodTypeAny {
	const enumValues = schema.enum?.filter((value): value is string => typeof value === "string");
	let field: z.ZodTypeAny;
	if (enumValues && enumValues.length === schema.enum?.length) {
		field = stringEnumToZod(enumValues) ?? z.string();
	} else {
		switch (jsonSchemaType(schema)) {
			case "integer":
				field = z.number().int();
				break;
			case "number":
				field = z.number();
				break;
			case "boolean":
				field = z.boolean();
				break;
			case "array":
				field = z.array(
					schema.items
						? jsonSchemaPropertyToZod(schema.items, `${fallbackDescription} item`)
						: z.any(),
				);
				break;
			case "object":
				field = jsonSchemaObjectToZod(schema);
				break;
			default:
				field = z.string();
		}
	}

	const desc = schema.description || fallbackDescription;
	field = field.describe(desc);
	return jsonSchemaAllowsNull(schema) ? field.nullable() : field;
}

function jsonSchemaObjectToZodShape(schema: JsonSchemaObject): NativeToolInputShape {
	const shape: NativeToolInputShape = {};
	for (const [key, prop] of Object.entries(schema.properties ?? {})) {
		const field = jsonSchemaPropertyToZod(prop, key);
		shape[key] = schema.required?.includes(key) ? field : field.optional();
	}

	return shape;
}

function jsonSchemaObjectToZod(schema: JsonSchemaObject): z.ZodTypeAny {
	const shape = jsonSchemaObjectToZodShape(schema);

	if (schema.properties) {
		const objectSchema = z.object(shape);
		if (schema.additionalProperties === false) {
			return objectSchema.strict();
		}
		if (typeof schema.additionalProperties === "object") {
			return objectSchema.catchall(
				jsonSchemaPropertyToZod(schema.additionalProperties, "additional property"),
			);
		}
		return objectSchema.passthrough();
	}

	if (typeof schema.additionalProperties === "object") {
		return z.record(
			z.string(),
			jsonSchemaPropertyToZod(schema.additionalProperties, "additional property"),
		);
	}
	return z.record(z.string(), z.any());
}

function buildConnectorToolSchema(tool: McpTool): {
	inputSchema: z.ZodTypeAny;
	inputShape: NativeToolInputShape;
	hasSchema: boolean;
} {
	const inputSchema = tool.inputSchema ?? tool.parameters;
	const hasSchema = Boolean(inputSchema?.properties || inputSchema?.type || inputSchema?.items);
	const fallbackShape: NativeToolInputShape = {
		arguments: z.string().optional().describe("JSON string of tool arguments"),
	};

	return {
		hasSchema,
		inputSchema: hasSchema ? jsonSchemaObjectToZod(inputSchema ?? {}) : z.object(fallbackShape),
		inputShape: inputSchema?.properties ? jsonSchemaObjectToZodShape(inputSchema) : fallbackShape,
	};
}

export function createConnectorToolDefinition(tool: McpTool) {
	const { inputSchema, inputShape, hasSchema } = buildConnectorToolSchema(tool);

	return {
		name: tool.name,
		description: tool.description || tool.name,
		inputSchema,
		inputShape,
		execute: async (params: Record<string, unknown>, callTool: ConnectorToolCaller) => {
			let args: Record<string, unknown>;
			if (hasSchema) {
				args = params;
			} else {
				const argsField = params.arguments;
				const parsedArgs =
					typeof argsField === "string" && argsField.length > 0 ? JSON.parse(argsField) : {};
				args = isRecord(parsedArgs) ? parsedArgs : {};
			}
			return await callTool(tool.name, args);
		},
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

	// Get MCP bridge config from the backend.
	const { getConfig } = await import("../lib/config");
	const cliConfig = getConfig();
	let mcpConfig: { mcp_url: string; mcp_token: string } | null = null;
	try {
		const raw = unwrap(await api.GET("/api/connectors/mcp-config"));
		mcpConfig = {
			...raw,
			// Backend may return localhost in dev; keep its selected path while
			// mapping local bind hosts to the CLI's configured API host.
			mcp_url: normalizeMcpUrl(raw.mcp_url, cliConfig.apiUrl),
		};
	} catch {
		process.stderr.write(
			"Warning: Could not get MCP bridge config. Connector tools unavailable.\n",
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

	registerNativeTool(
		server,
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
		async (params) => {
			const query = requiredStringParam(params, "query");
			if (!query) {
				return { content: [{ type: "text" as const, text: "Error: query is required." }] };
			}
			const limit = optionalNumberParam(params, "limit");
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

	registerNativeTool(
		server,
		"memory_add",
		'Store a durable memory so future agent sessions (same agent, or a different one) can retrieve this context. Call this when you learn something non-obvious about the user or their project that a future session would benefit from knowing.\n\nMUST call when:\n- The user explicitly asks you to remember something ("remember this", "save this", or equivalent in any language) — always honor the request\n- You just fixed a non-trivial bug — save ROOT CAUSE + fix, not just "bug fixed"\n- You and the user made an architecture decision together — save the decision AND the reasoning (why this option over alternatives)\n- The user expressed a coding / workflow preference you had to ask about — save it so you or another agent never asks again (e.g. "user prefers pnpm over npm")\n- The user shared personal info (their name, their project name, their team, who they work with) that future context would need\n\nDo NOT save:\n- Trivia that any agent can discover by reading the current code\n- Generic programming knowledge (how APIs work, language features)\n- Ephemeral conversation details ("the user asked about X today")\n- Plaintext tokens, API keys, bearer credentials, or private keys; use Vault and save a clawdi:// reference instead\n\nWrite the content as a standalone sentence with full context — include proper nouns, not pronouns. A future session will read it without today\'s conversation. Content language should match the user\'s primary language for that context.',
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
		async (params) => {
			const content = requiredStringParam(params, "content");
			if (!content) {
				return { content: [{ type: "text" as const, text: "Error: content is required." }] };
			}
			const category = isMemoryCategory(params.category) ? params.category : undefined;
			try {
				const finding = findLikelySecret(content);
				if (finding) {
					return {
						content: [
							{ type: "text" as const, text: `Error: ${formatSecretMemoryWarning(finding)}` },
						],
					};
				}
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

	registerNativeTool(
		server,
		"memory_extract",
		"Propose durable long-term memories from the CURRENT conversation, list them to the user, and save only what they approve. Call this when the user asks to 'extract memories', 'save what we discussed', 'remember this conversation', or any equivalent phrasing (in any language). The tool returns instructions — follow them exactly: list up to 5 candidates first, wait for the user's confirmation, then call memory_add on the approved ones. Do not narrate your internal workflow. This tool inspects your active conversation context — it does NOT read any external file or database.",
		{},
		() => ({
			content: [{ type: "text" as const, text: MEMORY_EXTRACT_INSTRUCTIONS }],
		}),
	);

	// --- Session tools (sharing + search) -------------------------------------
	//
	// Mirrors Amp's unified model: agents reference threads by URL/ID and
	// search past threads as a single capability — there is NO separate
	// "read shared" vs "read own" tool. The reference resolver routes to
	// the public-or-owner backend route by reference shape, so the agent
	// doesn't need to care which one it's holding.

	// Build URLs using the CLI's stored apiUrl. Note that for the public
	// share routes, anonymous fetch works — but we send the auth header
	// anyway because (a) the backend ignores it on public routes and
	// (b) it keeps the request shape identical to the owner-route case,
	// which keeps the api-client middleware / retry behavior simple.
	const apiBase = cliConfig.apiUrl;
	// Pull the API key off the shared ApiClient instance for direct
	// `fetch()` calls (the Markdown export endpoints return text, not
	// JSON, so the openapi-fetch typed wrapper isn't a great fit).
	const apiKey = (api as unknown as { apiKey?: string }).apiKey ?? "";
	const apiAuth: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

	const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const SHARE_URL_RE = /\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

	registerNativeTool(
		server,
		"session_read",
		"Read a Clawdi session and return its content as Markdown so you can ingest the conversation as context. Use this when the user references a Clawdi share URL (https://cloud.clawdi.ai/s/{uuid}) or one of their own sessions by UUID. Handles owned + shared sessions uniformly — you don't need to know which one. Returns the same Markdown shape as a WebFetch of the .md URL: a YAML front-matter block (source/agent/model/project/messages) followed by `## User` / `## Assistant` turn headings.",
		{
			reference: z
				.string()
				.describe(
					"Either a full Clawdi share URL (https://cloud.clawdi.ai/s/{uuid}) or a bare session UUID. URLs route to the public share endpoint (anonymous access when the link permission is on); bare UUIDs route to the owner endpoint via the CLI API key.",
				),
		},
		async (params) => {
			const reference = requiredStringParam(params, "reference");
			if (!reference) {
				return { content: [{ type: "text" as const, text: "Error: reference is required." }] };
			}
			const ref = reference.trim();
			let url: string;

			// Route by reference shape. The backend enforces access control;
			// the resolver only picks the URL.
			//   - `/s/{uuid}` in the input → public route (anon OK if linked)
			//   - bare UUID → owner route (CLI api-key auth)
			const urlMatch = ref.match(SHARE_URL_RE);
			if (urlMatch) {
				url = `${apiBase}/api/public/sessions/${urlMatch[1]}/export.md`;
			} else if (UUID_RE.test(ref)) {
				url = `${apiBase}/api/sessions/${ref}/export.md`;
			} else {
				return {
					content: [
						{
							type: "text" as const,
							text: "Reference must be a Clawdi share URL (https://cloud.clawdi.ai/s/{uuid}) or a session UUID.",
						},
					],
				};
			}

			try {
				const res = await fetch(url, { headers: apiAuth });
				if (!res.ok) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Session not found or not accessible (HTTP ${res.status}).`,
							},
						],
					};
				}
				return { content: [{ type: "text" as const, text: await res.text() }] };
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text" as const, text: `Error fetching session: ${message}` }],
				};
			}
		},
	);

	type SessionItem = {
		id: string;
		summary?: string | null;
		local_session_id?: string;
		project_path?: string | null;
		model?: string | null;
		agent_type?: string | null;
		last_activity_at?: string | null;
		message_count?: number;
	};

	const formatSessionLines = (items: SessionItem[]): string =>
		items
			.map((s) => {
				const date = s.last_activity_at
					? new Date(s.last_activity_at).toISOString().slice(0, 10)
					: "—";
				const summary = s.summary || s.local_session_id || "(untitled)";
				const project = s.project_path ? ` · ${s.project_path}` : "";
				const model = s.model ? ` · ${s.model}` : "";
				return `- **${summary}**${project}${model}\n  - id: \`${s.id}\` · ${s.agent_type ?? "unknown"} · ${date} · ${s.message_count ?? 0} msgs`;
			})
			.join("\n");

	registerNativeTool(
		server,
		"session_search",
		"Search the user's past Clawdi sessions by keyword. Use when the user asks about prior work (e.g. 'find the auth migration session'). Returns up to N matching sessions with summary, agent, model, project, started_at, and message count. The session UUID in each result can be passed back to session_read to fetch the full conversation.",
		{
			query: z
				.string()
				.describe(
					"Keyword query — matches against session summary and metadata via pg_trgm substring ranking with typo tolerance.",
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(20)
				.optional()
				.describe("Max results to return (default 10, max 20)."),
		},
		async (params) => {
			const query = requiredStringParam(params, "query");
			if (!query) {
				return { content: [{ type: "text" as const, text: "Error: query is required." }] };
			}
			const limit = optionalNumberParam(params, "limit");
			const cap = limit ?? 10;
			try {
				const { items } = unwrap(
					await api.GET("/api/sessions", {
						params: { query: { q: query, page_size: cap } },
					}),
				);
				if (items.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No sessions matched "${query}". Try a broader phrase, fewer filter words, or check the dashboard.`,
							},
						],
					};
				}
				const lines = formatSessionLines(items);
				return {
					content: [
						{
							type: "text" as const,
							text: `Found ${items.length} session${items.length === 1 ? "" : "s"} matching "${query}":\n\n${lines}`,
						},
					],
				};
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text" as const, text: `Search failed: ${message}` }],
				};
			}
		},
	);

	// --- Dynamically registered connector tools (from Composio via backend) ---

	if (mcpConfig && remoteTools.length > 0) {
		const { mcp_url: bridgeUrl, mcp_token: bridgeToken } = mcpConfig;
		const callTool = async (toolName: string, args: Record<string, unknown>) => {
			const resp = await fetch(bridgeUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${bridgeToken}`,
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
			const definition = createConnectorToolDefinition(tool);

			registerNativeTool(
				server,
				definition.name,
				definition.description,
				definition.inputShape,
				async (params) => {
					try {
						const result = await definition.execute(params, callTool);
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
