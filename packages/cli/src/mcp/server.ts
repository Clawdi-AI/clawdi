import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type ServerResult,
} from "@modelcontextprotocol/sdk/types.js";
import { getClawdiAccessToken } from "../lib/clerk-oauth";
import { getConfig, isLoggedIn } from "../lib/config";
import { timedFetch } from "../lib/timed-fetch";

interface JsonRpcResponse {
	result?: unknown;
	error?: unknown;
}

export type ClawdiMcpCaller = (
	method: string,
	params?: Record<string, unknown>,
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireMcpResult(method: string, result: unknown): Record<string, unknown> {
	if (isRecord(result)) return result;
	throw new Error(`Clawdi MCP ${method} returned an invalid result`);
}

function requireMcpLogin(): void {
	if (!isLoggedIn()) {
		throw new Error("Not logged in. Run `clawdi auth login` first.");
	}
}

function ensureMcpLogin(): void {
	try {
		requireMcpLogin();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exit(1);
	}
}

const MCP_ENDPOINT_PATH = "/v1/mcp/clawdi";
const MCP_FORWARD_TIMEOUT_MS = 30_000;

export async function callClawdiMcp(
	method: string,
	params?: Record<string, unknown>,
	timeoutMs = MCP_FORWARD_TIMEOUT_MS,
): Promise<unknown> {
	const config = getConfig();
	const accessToken = await getClawdiAccessToken(config.apiUrl);
	const response = await timedFetch(
		`${config.apiUrl}${MCP_ENDPOINT_PATH}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }),
		},
		timeoutMs,
	);
	if (!response.ok) {
		throw new Error(`Clawdi MCP request failed (HTTP ${response.status})`);
	}
	const body = (await response.json()) as JsonRpcResponse;
	if (body.error) {
		throw new Error(typeof body.error === "string" ? body.error : JSON.stringify(body.error));
	}
	return body.result;
}

/**
 * Build a protocol-transparent tools proxy. The stdio adapter deliberately
 * does not reconstruct tool definitions or results through a local schema:
 * /v1/mcp/clawdi remains the runtime authority for native and dynamic tools.
 */
export function createTransparentMcpHandlers(callMcp: ClawdiMcpCaller) {
	return {
		listTools: async (params: Record<string, unknown> = {}) =>
			requireMcpResult("tools/list", await callMcp("tools/list", params)),
		callTool: async (params: Record<string, unknown>) =>
			requireMcpResult("tools/call", await callMcp("tools/call", params)),
	};
}

export function createTransparentMcpServer(callMcp: ClawdiMcpCaller): Server {
	const server = new Server(
		{
			name: "clawdi",
			version: "0.0.1",
		},
		{ capabilities: { tools: {} } },
	);
	const handlers = createTransparentMcpHandlers(callMcp);

	server.setRequestHandler(ListToolsRequestSchema, async (request) => {
		const params = isRecord(request.params) ? request.params : {};
		return (await handlers.listTools(params)) as ServerResult;
	});
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		try {
			return (await handlers.callTool(request.params)) as ServerResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
		}
	});

	return server;
}

export async function createClawdiMcpServer(): Promise<Server> {
	requireMcpLogin();
	return createTransparentMcpServer(callClawdiMcp);
}

export async function startMcpServer() {
	ensureMcpLogin();
	const server = await createClawdiMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
