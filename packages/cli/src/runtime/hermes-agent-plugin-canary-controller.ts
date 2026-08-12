import { renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const CONTROLLER_LIFETIME_MS = 45_000;

export interface HermesAgentPluginCanaryControllerOptions {
	readyFile: string;
	resultFile: string;
	nonce: string;
	successToken: string;
}

interface CanaryEvidence {
	mcpInitialize: boolean;
	mcpInitialized: boolean;
	mcpToolsList: boolean;
	mcpToolCall: boolean;
	inferenceSawTool: boolean;
	inferenceSawToolResult: boolean;
	completed: boolean;
	error?: string;
}

function writeJsonAtomic(path: string, value: unknown, nonce: string): void {
	const temporary = `${path}.${process.pid}.${nonce}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> {
	const parsed: unknown = JSON.parse(bytes.toString("utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += bytes.length;
		if (length > MAX_REQUEST_BYTES) throw new Error("request body is too large");
		chunks.push(bytes);
	}
	return Buffer.concat(chunks, length);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		Connection: "close",
	});
	response.end(JSON.stringify(body));
}

function chatChunk(input: {
	model: string;
	delta: Record<string, unknown>;
	finishReason: string | null;
}): Record<string, unknown> {
	return {
		id: "chatcmpl-clawdi-agent-plugin-canary",
		object: "chat.completion.chunk",
		created: 0,
		model: input.model,
		choices: [
			{
				index: 0,
				delta: input.delta,
				finish_reason: input.finishReason,
			},
		],
	};
}

function writeChatStream(
	response: ServerResponse,
	chunks: readonly Record<string, unknown>[],
): void {
	response.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-store",
		Connection: "close",
	});
	for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end("data: [DONE]\n\n");
}

function writeChatCompletion(response: ServerResponse, model: string, content: string): void {
	writeJson(response, 200, {
		id: "chatcmpl-clawdi-agent-plugin-canary",
		object: "chat.completion",
		created: 0,
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
}

function writeEmptyChatStream(response: ServerResponse, model: string): void {
	writeChatStream(response, [
		chatChunk({ model, delta: { role: "assistant", content: "" }, finishReason: null }),
		chatChunk({ model, delta: {}, finishReason: "stop" }),
	]);
}

function requestMethods(body: Record<string, unknown>): string[] {
	const messages = Array.isArray(body) ? body : [body];
	return messages.flatMap((message) => {
		if (typeof message !== "object" || message === null || !("method" in message)) return [];
		return typeof message.method === "string" ? [message.method] : [];
	});
}

function advertisedCanaryTool(body: Record<string, unknown>, description: string): string | null {
	if (!Array.isArray(body.tools) || body.tools.length !== 1) return null;
	const tool = body.tools[0];
	if (typeof tool !== "object" || tool === null || !("function" in tool)) return null;
	const fn = tool.function;
	if (typeof fn !== "object" || fn === null) return null;
	if (!("name" in fn) || typeof fn.name !== "string") return null;
	if (!("description" in fn) || fn.description !== description) return null;
	if (!/^mcp__[A-Za-z0-9_]+__clawdi_agent_plugin_canary$/.test(fn.name)) return null;
	return fn.name;
}

function hasExpectedToolResult(
	body: Record<string, unknown>,
	callId: string,
	nonce: string,
): boolean {
	if (!Array.isArray(body.messages)) return false;
	return body.messages.some((message) => {
		if (typeof message !== "object" || message === null) return false;
		if (!("role" in message) || message.role !== "tool") return false;
		if (!("tool_call_id" in message) || message.tool_call_id !== callId) return false;
		if (!("content" in message)) return false;
		return typeof message.content === "string" && message.content.includes(nonce);
	});
}

function assertControllerOptions(options: HermesAgentPluginCanaryControllerOptions): void {
	if (!isAbsolute(options.readyFile) || !isAbsolute(options.resultFile)) {
		throw new Error("canary controller paths must be absolute");
	}
	if (!/^[a-f0-9]{32}$/.test(options.nonce)) throw new Error("invalid canary nonce");
	if (!/^CLAWDI_AGENT_PLUGIN_CANARY_OK_[a-f0-9]{32}$/.test(options.successToken)) {
		throw new Error("invalid canary success token");
	}
}

export async function runHermesAgentPluginCanaryController(
	options: HermesAgentPluginCanaryControllerOptions,
): Promise<void> {
	assertControllerOptions(options);
	const evidence: CanaryEvidence = {
		mcpInitialize: false,
		mcpInitialized: false,
		mcpToolsList: false,
		mcpToolCall: false,
		inferenceSawTool: false,
		inferenceSawToolResult: false,
		completed: false,
	};
	const persistEvidence = () => {
		writeJsonAtomic(options.resultFile, evidence, options.nonce);
	};
	const fail = (message: string) => {
		evidence.error ??= message;
		persistEvidence();
	};

	const model = "clawdi-agent-plugin-canary";
	const callId = `call_${options.nonce}`;
	const toolDescription = `Return the isolated Clawdi Agent Plugin capability nonce ${options.nonce}`;
	let canaryTool: string | null = null;
	let inferenceCalls = 0;
	const server = createServer(async (request, response) => {
		try {
			const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
			if (pathname === "/mcp") {
				if (request.method === "HEAD") {
					writeJson(response, 405, { error: "POST required" });
					return;
				}
				if (request.method === "POST") {
					const body = parseJsonObject(await readRequestBody(request));
					for (const method of requestMethods(body)) {
						if (method === "initialize") evidence.mcpInitialize = true;
						if (method === "notifications/initialized") evidence.mcpInitialized = true;
						if (method === "tools/list") evidence.mcpToolsList = true;
					}
					persistEvidence();
					const mcp = new McpServer(
						{ name: "clawdi-agent-plugin-capability-canary", version: "1.0.0" },
						{ capabilities: { tools: {} } },
					);
					mcp.registerTool(
						"clawdi_agent_plugin_canary",
						{ description: toolDescription },
						async () => {
							evidence.mcpToolCall = true;
							persistEvidence();
							return { content: [{ type: "text", text: options.nonce }] };
						},
					);
					const transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: undefined,
						enableJsonResponse: true,
					});
					response.once("close", () => {
						void transport.close();
						void mcp.close();
					});
					await mcp.connect(transport);
					await transport.handleRequest(request, response, body);
					return;
				}
				writeJson(response, 405, {
					jsonrpc: "2.0",
					error: { code: -32_000, message: "Method not allowed" },
					id: null,
				});
				return;
			}

			if (pathname === "/v1/models" && request.method === "GET") {
				writeJson(response, 200, {
					object: "list",
					data: [{ id: model, object: "model", created: 0, owned_by: "clawdi" }],
				});
				return;
			}
			if (pathname !== "/v1/chat/completions" || request.method !== "POST") {
				writeJson(response, 404, {
					error: { message: "not found", type: "invalid_request_error" },
				});
				return;
			}
			if (request.headers.authorization !== `Bearer clawdi-${options.nonce}`) {
				fail("inference request used an unexpected authorization value");
				writeJson(response, 401, {
					error: { message: "unauthorized", type: "authentication_error" },
				});
				return;
			}
			const body = parseJsonObject(await readRequestBody(request));
			if (body.model !== model) {
				fail("inference request did not use the bounded canary model");
				writeJson(response, 400, {
					error: { message: "invalid canary request", type: "invalid_request_error" },
				});
				return;
			}
			if (!Array.isArray(body.tools) || body.tools.length === 0) {
				if (body.stream === true) writeEmptyChatStream(response, model);
				else writeChatCompletion(response, model, "");
				return;
			}
			if (body.stream !== true) {
				fail("canary inference request did not use the streaming path");
				writeJson(response, 400, {
					error: { message: "invalid canary request", type: "invalid_request_error" },
				});
				return;
			}
			inferenceCalls += 1;
			if (inferenceCalls === 1) {
				canaryTool = advertisedCanaryTool(body, toolDescription);
				if (!canaryTool) {
					fail("portable Agent Plugin canary tool was not advertised to inference");
					writeJson(response, 400, {
						error: { message: "canary tool missing", type: "invalid_request_error" },
					});
					return;
				}
				evidence.inferenceSawTool = true;
				persistEvidence();
				writeChatStream(response, [
					chatChunk({
						model,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: callId,
									type: "function",
									function: { name: canaryTool, arguments: "{}" },
								},
							],
						},
						finishReason: null,
					}),
					chatChunk({ model, delta: {}, finishReason: "tool_calls" }),
				]);
				return;
			}
			if (
				inferenceCalls === 2 &&
				advertisedCanaryTool(body, toolDescription) === canaryTool &&
				hasExpectedToolResult(body, callId, options.nonce)
			) {
				evidence.inferenceSawToolResult = true;
				evidence.completed = true;
				persistEvidence();
				writeChatStream(response, [
					chatChunk({
						model,
						delta: { role: "assistant", content: options.successToken },
						finishReason: null,
					}),
					chatChunk({ model, delta: {}, finishReason: "stop" }),
				]);
				return;
			}
			fail("inference did not receive the exact canary MCP tool result");
			writeJson(response, 400, {
				error: { message: "canary result missing", type: "invalid_request_error" },
			});
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
			if (!response.headersSent) {
				writeJson(response, 500, {
					error: { message: "canary controller failure", type: "server_error" },
				});
			} else if (!response.writableEnded) {
				response.end();
			}
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("canary controller address is invalid");
	persistEvidence();
	writeJsonAtomic(options.readyFile, { port: address.port }, options.nonce);

	await new Promise<void>((resolve) => {
		let closing = false;
		const close = (timedOut: boolean) => {
			if (closing) return;
			closing = true;
			if (timedOut) {
				fail("canary controller lifetime expired");
				process.exitCode = 1;
			}
			server.close(() => resolve());
		};
		const timer = setTimeout(() => close(true), CONTROLLER_LIFETIME_MS);
		const stop = () => {
			clearTimeout(timer);
			close(false);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}
