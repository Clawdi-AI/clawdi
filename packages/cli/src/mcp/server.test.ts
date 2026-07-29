import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	callClawdiMcp,
	createClawdiMcpServer,
	createTransparentMcpHandlers,
	createTransparentMcpServer,
} from "./server";

describe("MCP stdio proxy", () => {
	it("throws instead of exiting when there is no CLI auth", async () => {
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

	it("aborts a stalled MCP forwarding request at the configured deadline", async () => {
		const previousAuthToken = process.env.CLAWDI_AUTH_TOKEN;
		const previousAuthTokenOrigin = process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
		const previousApiUrl = process.env.CLAWDI_API_URL;
		const originalFetch = globalThis.fetch;
		process.env.CLAWDI_AUTH_TOKEN = "test-mcp-token";
		process.env.CLAWDI_AUTH_TOKEN_ORIGIN = "http://localhost:8000";
		process.env.CLAWDI_API_URL = "http://localhost:8000";
		let aborted = false;
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							controller.error(new DOMException("Aborted", "AbortError"));
						},
						{ once: true },
					);
				},
			});
			return new Response(body, { status: 200 });
		}) as typeof fetch;
		try {
			await expect(callClawdiMcp("tools/list", {}, 10)).rejects.toThrow(
				"request timed out after 10ms",
			);
			expect(aborted).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
			if (previousAuthToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = previousAuthToken;
			if (previousAuthTokenOrigin === undefined) delete process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
			else process.env.CLAWDI_AUTH_TOKEN_ORIGIN = previousAuthTokenOrigin;
			if (previousApiUrl === undefined) delete process.env.CLAWDI_API_URL;
			else process.env.CLAWDI_API_URL = previousApiUrl;
		}
	});

	it("preserves complete runtime tool definitions without a hardcoded catalog", async () => {
		const upstream = {
			tools: [
				{
					name: "COMPOSIO_SEARCH_TOOLS",
					description: "Search current tools",
					inputSchema: {
						type: "object",
						properties: {
							queries: {
								type: "array",
								items: {
									type: "object",
									properties: { known_fields: { type: ["string", "null"] } },
								},
							},
						},
					},
					outputSchema: {
						type: "object",
						properties: { redirect_url: { type: ["string", "null"] } },
					},
					_meta: { composio: { future_contract: true } },
					futureDefinitionField: { preserved: true },
				},
			],
			nextCursor: "next-page",
			_meta: { router: { session: "opaque" } },
		};
		const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
		const handlers = createTransparentMcpHandlers(async (method, params) => {
			calls.push({ method, params });
			return upstream;
		});
		const params = { cursor: "page-1", _meta: { trace: "opaque" } };

		const result = await handlers.listTools(params);

		expect(result).toBe(upstream);
		expect(calls).toEqual([{ method: "tools/list", params }]);
	});

	it("preserves nested arguments and complete structured tool results", async () => {
		const upstream = {
			content: [
				{
					type: "text",
					text: '{"status":"initiated"}',
					_meta: { composio: { tool: "COMPOSIO_MANAGE_CONNECTIONS" } },
				},
			],
			structuredContent: {
				status: "initiated",
				redirect_url: "https://connect.test/link",
			},
			redirect_url: "https://connect.test/link",
			_meta: { future: { preserved: true } },
			futureResultField: { preserved: true },
		};
		const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
		const handlers = createTransparentMcpHandlers(async (method, params) => {
			calls.push({ method, params });
			return upstream;
		});
		const params = {
			name: "COMPOSIO_MULTI_EXECUTE_TOOL",
			arguments: {
				tasks: [
					{
						slug: "GITHUB_CREATE_ISSUE",
						arguments: { title: "Bug", labels: ["runtime", "mcp"] },
					},
				],
			},
			_meta: { progressToken: "progress-1" },
		};

		const result = await handlers.callTool(params);

		expect(result).toBe(upstream);
		expect(calls).toEqual([{ method: "tools/call", params }]);
	});

	it("keeps runtime schemas and result extensions across the stdio server protocol", async () => {
		const toolDefinition = {
			name: "COMPOSIO_MANAGE_CONNECTIONS",
			inputSchema: { type: "object" as const, properties: { toolkit: { type: "string" } } },
			outputSchema: {
				type: "object" as const,
				properties: { redirect_url: { type: ["string", "null"] } },
			},
			_meta: { composio: { version: "future" } },
			futureDefinitionField: { preserved: true },
		};
		const toolResult = {
			content: [{ type: "text", text: "connection initiated" }],
			structuredContent: { redirect_url: "https://connect.test/link" },
			redirect_url: "https://connect.test/link",
			_meta: { composio: { version: "future" } },
			futureResultField: { preserved: true },
		};
		const server = createTransparentMcpServer(async (method) =>
			method === "tools/list" ? { tools: [toolDefinition] } : toolResult,
		);
		const client = new Client({ name: "clawdi-proxy-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		try {
			const listResult = await client.listTools();
			const callResult = await client.callTool({
				name: toolDefinition.name,
				arguments: { toolkit: "github" },
			});

			expect(listResult.tools).toHaveLength(1);
			expect(listResult.tools[0]?.outputSchema).toEqual(toolDefinition.outputSchema);
			expect(listResult.tools[0]?._meta).toEqual(toolDefinition._meta);
			expect(callResult.structuredContent).toEqual(toolResult.structuredContent);
			expect(callResult.redirect_url).toBe(toolResult.redirect_url);
			expect(callResult._meta).toEqual(toolResult._meta);
			expect(callResult.futureResultField).toEqual(toolResult.futureResultField);
		} finally {
			await client.close();
			await server.close();
		}
	});

	it("fails closed when the aggregate returns a non-object result", async () => {
		const handlers = createTransparentMcpHandlers(async () => ["not", "an", "mcp", "result"]);

		await expect(handlers.listTools()).rejects.toThrow(
			"Clawdi MCP tools/list returned an invalid result",
		);
	});
});
