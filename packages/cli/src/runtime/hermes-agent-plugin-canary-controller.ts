import { renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { withRuntimeUserFileAccess } from "./runtime-user-command";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const CONTROLLER_LIFETIME_MS = 45_000;
const requestObjectSchema = z.record(z.string(), z.unknown());

export interface HermesAgentPluginCanaryControllerOptions {
	readyFile: string;
	resultFile: string;
	nonce: string;
}

interface CanaryEvidence {
	mcpToolsList: boolean;
	mcpToolCall: boolean;
	error?: string;
}

function writeJsonAtomic(path: string, value: unknown, nonce: string): void {
	withRuntimeUserFileAccess(() => {
		const temporary = `${path}.${process.pid}.${nonce}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
			renameSync(temporary, path);
		} finally {
			rmSync(temporary, { force: true });
		}
	});
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> {
	const parsed: unknown = JSON.parse(bytes.toString("utf8"));
	const object = requestObjectSchema.safeParse(parsed);
	if (!object.success) {
		throw new Error("request body must be a JSON object");
	}
	return object.data;
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

function writeChatCompletion(
	response: ServerResponse,
	model: string,
	message: Record<string, unknown>,
	finishReason: "stop" | "tool_calls",
): void {
	writeJson(response, 200, {
		id: "chatcmpl-clawdi-agent-plugin-canary",
		object: "chat.completion",
		created: 0,
		model,
		choices: [
			{
				index: 0,
				message,
				finish_reason: finishReason,
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

function advertisedCanaryTool(body: Record<string, unknown>): string | null {
	if (!Array.isArray(body.tools)) return null;
	const matches = body.tools.flatMap((tool) => {
		if (typeof tool !== "object" || tool === null || !("function" in tool)) return [];
		const fn = tool.function;
		if (typeof fn !== "object" || fn === null || !("name" in fn)) return [];
		return typeof fn.name === "string" &&
			/^mcp__[A-Za-z0-9_]+__clawdi_agent_plugin_canary$/.test(fn.name)
			? [fn.name]
			: [];
	});
	return matches.length === 1 ? (matches[0] ?? null) : null;
}

function assertControllerOptions(options: HermesAgentPluginCanaryControllerOptions): void {
	if (!isAbsolute(options.readyFile) || !isAbsolute(options.resultFile)) {
		throw new Error("canary controller paths must be absolute");
	}
	if (!/^[a-f0-9]{32}$/.test(options.nonce)) throw new Error("invalid canary nonce");
}

export async function runHermesAgentPluginCanaryController(
	options: HermesAgentPluginCanaryControllerOptions,
): Promise<void> {
	assertControllerOptions(options);
	const evidence: CanaryEvidence = {
		mcpToolsList: false,
		mcpToolCall: false,
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
	const server = createServer(async (request, response) => {
		try {
			const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
			if (pathname === "/mcp") {
				if (request.headers["x-clawdi-agent-plugin-canary"] !== `clawdi-${options.nonce}`) {
					fail("portable Agent Plugin canary header was missing or invalid");
					writeJson(response, 401, {
						jsonrpc: "2.0",
						error: { code: -32_000, message: "Unauthorized" },
						id: null,
					});
					return;
				}
				if (request.method === "HEAD") {
					writeJson(response, 405, { error: "POST required" });
					return;
				}
				if (request.method === "POST") {
					const body = parseJsonObject(await readRequestBody(request));
					for (const method of requestMethods(body)) {
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
			const canaryTool = advertisedCanaryTool(body);
			if (!canaryTool || evidence.mcpToolCall) {
				if (body.stream === true) writeEmptyChatStream(response, model);
				else writeChatCompletion(response, model, { role: "assistant", content: "" }, "stop");
				return;
			}
			const toolCall = {
				id: callId,
				type: "function",
				function: { name: canaryTool, arguments: "{}" },
			};
			if (body.stream !== true) {
				writeChatCompletion(
					response,
					model,
					{ role: "assistant", content: null, tool_calls: [toolCall] },
					"tool_calls",
				);
				return;
			}
			writeChatStream(response, [
				chatChunk({
					model,
					delta: { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] },
					finishReason: null,
				}),
				chatChunk({ model, delta: {}, finishReason: "tool_calls" }),
			]);
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
