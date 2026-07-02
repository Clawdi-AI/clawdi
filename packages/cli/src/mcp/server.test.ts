import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createClawdiMcpServer,
	createConnectorToolDefinition,
	type McpTool,
	mcpHttpRequestAuthorized,
	normalizeMcpUrl,
} from "./server";

describe("MCP connector helpers", () => {
	it("requires the expected bearer token for MCP HTTP requests", () => {
		expect(mcpHttpRequestAuthorized("Bearer sidecar-token", "sidecar-token")).toBe(true);
		expect(mcpHttpRequestAuthorized("Bearer wrong", "sidecar-token")).toBe(false);
		expect(mcpHttpRequestAuthorized(undefined, "sidecar-token")).toBe(false);
		expect(mcpHttpRequestAuthorized("Basic sidecar-token", "sidecar-token")).toBe(false);
	});

	it("throws instead of exiting when MCP HTTP request setup has no CLI auth", async () => {
		const previousClawdiHome = process.env.CLAWDI_HOME;
		const previousAuthToken = process.env.CLAWDI_AUTH_TOKEN;
		const clawdiHome = mkdtempSync(join(tmpdir(), "clawdi-mcp-auth-"));
		process.env.CLAWDI_HOME = clawdiHome;
		delete process.env.CLAWDI_AUTH_TOKEN;
		try {
			await expect(createClawdiMcpServer()).rejects.toThrow("Not logged in");
		} finally {
			if (previousClawdiHome === undefined) delete process.env.CLAWDI_HOME;
			else process.env.CLAWDI_HOME = previousClawdiHome;
			if (previousAuthToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = previousAuthToken;
			rmSync(clawdiHome, { recursive: true, force: true });
		}
	});

	it("normalizes localhost MCP URLs without changing the backend-selected path", () => {
		expect(
			normalizeMcpUrl(
				"http://localhost:8000/api/mcp/composio?session=abc#tools",
				"https://cloud-api.clawdi.ai",
			),
		).toBe("https://cloud-api.clawdi.ai/api/mcp/composio?session=abc#tools");
	});

	it("leaves non-local MCP URLs unchanged", () => {
		expect(
			normalizeMcpUrl(
				"https://app.composio.dev/tool_router/v3/trs_123/mcp",
				"https://cloud-api.clawdi.ai",
			),
		).toBe("https://app.composio.dev/tool_router/v3/trs_123/mcp");
	});

	it("preserves upstream tool names and builds typed fields from inputSchema", async () => {
		const tool: McpTool = {
			name: "COMPOSIO_SEARCH_TOOLS",
			description: "Search tools",
			inputSchema: {
				properties: {
					query: { type: "string", description: "Search query" },
					limit: { type: "integer", description: "Maximum results" },
				},
				required: ["query"],
			},
		};

		const definition = createConnectorToolDefinition(tool);
		expect(definition.name).toBe("COMPOSIO_SEARCH_TOOLS");

		expect(definition.inputSchema.safeParse({ query: "github issues", limit: 5 }).success).toBe(
			true,
		);
		expect(definition.inputSchema.safeParse({ limit: 5 }).success).toBe(false);

		let forwardedName = "";
		let forwardedArgs: Record<string, unknown> = {};
		const result = await definition.execute(
			{ query: "github issues", limit: 5 },
			async (name, args) => {
				forwardedName = name;
				forwardedArgs = args;
				return { ok: true };
			},
		);

		expect(result).toEqual({ ok: true });
		expect(forwardedName).toBe("COMPOSIO_SEARCH_TOOLS");
		expect(forwardedArgs).toEqual({ query: "github issues", limit: 5 });
	});

	it("falls back to parameters and forwards parsed JSON arguments when schema is absent", async () => {
		const parameterBacked = createConnectorToolDefinition({
			name: "GITHUB_CREATE_ISSUE",
			parameters: {
				properties: {
					title: { type: "string" },
				},
				required: ["title"],
			},
		});
		expect(parameterBacked.inputSchema.safeParse({ title: "Bug" }).success).toBe(true);

		const generic = createConnectorToolDefinition({ name: "COMPOSIO_MULTI_EXECUTE_TOOL" });
		let forwardedArgs: Record<string, unknown> = {};
		await generic.execute(
			{ arguments: '{"tasks":[{"slug":"GITHUB_GET_ISSUE"}]}' },
			async (_name, args) => {
				forwardedArgs = args;
				return null;
			},
		);

		expect(forwardedArgs).toEqual({ tasks: [{ slug: "GITHUB_GET_ISSUE" }] });
	});

	it("preserves nested inputSchema structure for Composio meta tools", () => {
		const definition = createConnectorToolDefinition({
			name: "COMPOSIO_SEARCH_TOOLS",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					queries: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								use_case: { type: "string", description: "Tool use case" },
								known_fields: { type: ["string", "null"] },
							},
							required: ["use_case"],
						},
					},
				},
				required: ["queries"],
			},
		});

		expect(
			definition.inputSchema.safeParse({
				queries: [{ use_case: "find GitHub tools for listing repository issues" }],
			}).success,
		).toBe(true);
		expect(definition.inputSchema.safeParse({ queries: [{}] }).success).toBe(false);
		expect(definition.inputSchema.safeParse({ queries: "github issues" }).success).toBe(false);
		expect(
			definition.inputSchema.safeParse({
				queries: [{ use_case: "search", extra: "not allowed" }],
			}).success,
		).toBe(false);
	});
});
