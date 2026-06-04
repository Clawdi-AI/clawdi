import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	request,
	type Server,
	type ServerResponse,
} from "node:http";
import { getDaemonControlDir, getDaemonControlTokenPath } from "./paths";

const MAX_RPC_BODY_BYTES = 1024 * 1024;
export const DEFAULT_CONTROL_RPC_HOST = "127.0.0.1";
export const DEFAULT_CONTROL_RPC_PORT = 17654;

export type ControlRpcHandler = (params: unknown) => Promise<unknown> | unknown;
export type ControlRpcHandlers = Record<string, ControlRpcHandler>;

export interface ControlRpcListenConfig {
	host?: string;
	port?: number;
	allowRemote?: boolean;
}

export interface ControlRpcClientConfig {
	host?: string;
	port?: number;
	token?: string;
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: unknown;
}

interface ControlRpcServer {
	tokenPath: string;
	http: { host: string; port: number };
	close: () => Promise<void>;
}

export async function startControlRpcServer(
	handlers: ControlRpcHandlers,
	abort: AbortSignal,
	config: ControlRpcListenConfig = {},
): Promise<ControlRpcServer> {
	const host = config.host ?? DEFAULT_CONTROL_RPC_HOST;
	const port = config.port ?? DEFAULT_CONTROL_RPC_PORT;
	if (config.allowRemote !== true && !isLoopbackRpcHost(host)) {
		throw new Error(
			`Refusing to listen on non-loopback HTTP RPC host ${host}. ` +
				"Use --rpc-allow-remote only behind SSH tunneling or a TLS-terminating proxy.",
		);
	}
	const controlDir = getDaemonControlDir();
	mkdirSync(controlDir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(controlDir, 0o700);
	} catch {
		/* best effort */
	}
	ensureControlToken();
	const httpServer = createServer(async (req, res) => {
		await handleHttpRequest(req, res, handlers);
	});
	try {
		await listenOnHttpEndpoint(httpServer, host, port);
	} catch (error) {
		await closeServer(httpServer);
		throw error;
	}
	const address = httpServer.address();
	const http = {
		host,
		port: typeof address === "object" && address ? address.port : port,
	};
	const close = () => closeServer(httpServer);
	abort.addEventListener(
		"abort",
		() => {
			void close();
		},
		{ once: true },
	);
	return { tokenPath: getDaemonControlTokenPath(), http, close };
}

export async function callControlRpc(
	method: string,
	params?: unknown,
	config: ControlRpcClientConfig = {},
): Promise<unknown> {
	if (config.host !== undefined && config.port === undefined) {
		config = { ...config, port: DEFAULT_CONTROL_RPC_PORT };
	}
	const token = config.token ?? process.env.CLAWDI_DAEMON_RPC_TOKEN ?? readControlToken();
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method,
		params: params ?? {},
	});
	const response = await new Promise<string>((resolve, reject) => {
		const req = createServerlessRequest(body, token, config, resolve, reject);
		req.write(body);
		req.end();
	});
	const parsed = JSON.parse(response) as {
		error?: { code?: number; message?: string };
		result?: unknown;
	};
	if (parsed.error) {
		throw new Error(parsed.error.message ?? "RPC call failed");
	}
	return parsed.result;
}

function createServerlessRequest(
	body: string,
	token: string,
	config: ControlRpcClientConfig,
	resolve: (value: string) => void,
	reject: (reason?: unknown) => void,
) {
	const req = request(
		{
			hostname: config.host ?? DEFAULT_CONTROL_RPC_HOST,
			port: config.port ?? DEFAULT_CONTROL_RPC_PORT,
			path: "/rpc",
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
			},
		},
		(res) => {
			let chunks = "";
			res.setEncoding("utf-8");
			res.on("data", (chunk) => {
				chunks += chunk;
			});
			res.on("end", () => {
				if ((res.statusCode ?? 500) >= 400) {
					reject(new Error(chunks || `RPC HTTP ${res.statusCode}`));
					return;
				}
				resolve(chunks);
			});
		},
	);
	req.on("error", reject);
	return req;
}

function ensureControlToken(): string {
	const tokenPath = getDaemonControlTokenPath();
	if (existsSync(tokenPath)) {
		return readControlToken();
	}
	return rotateControlToken();
}

export function rotateControlToken(): string {
	const controlDir = getDaemonControlDir();
	mkdirSync(controlDir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(controlDir, 0o700);
	} catch {
		/* best effort */
	}
	const tokenPath = getDaemonControlTokenPath();
	const token = randomBytes(32).toString("hex");
	writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
	try {
		chmodSync(tokenPath, 0o600);
	} catch {
		/* best effort */
	}
	return token;
}

function readControlToken(): string {
	const tokenPath = getDaemonControlTokenPath();
	if (!existsSync(tokenPath)) {
		throw new Error(
			`daemon control token not found at ${tokenPath}. Start \`clawdi daemon run\` first.`,
		);
	}
	try {
		chmodSync(tokenPath, 0o600);
	} catch {
		/* best effort */
	}
	const token = readFileSync(tokenPath, "utf-8").trim();
	if (!token) throw new Error(`daemon control token at ${tokenPath} is empty`);
	return token;
}

async function handleHttpRequest(
	req: IncomingMessage,
	res: ServerResponse,
	handlers: ControlRpcHandlers,
): Promise<void> {
	if (req.method !== "POST" || req.url !== "/rpc") {
		sendHttp(res, 404, { error: "not_found" });
		return;
	}
	let token: string;
	try {
		token = readControlToken();
	} catch (error) {
		sendHttp(res, 500, { error: error instanceof Error ? error.message : "token_unavailable" });
		return;
	}
	const auth = req.headers.authorization;
	if (!bearerTokenMatches(auth, token)) {
		sendHttp(res, 401, { error: "unauthorized" });
		return;
	}
	let raw: string;
	try {
		raw = await readBody(req);
	} catch (error) {
		if (!res.destroyed && !res.writableEnded) {
			sendRpcError(res, null, -32600, error instanceof Error ? error.message : "Invalid request");
		}
		return;
	}
	let request: JsonRpcRequest;
	try {
		request = parseJsonRpcRequest(raw);
	} catch (error) {
		sendRpcError(res, null, -32600, error instanceof Error ? error.message : "Invalid request");
		return;
	}
	const handler = handlers[request.method];
	if (!handler) {
		sendRpcError(res, request.id ?? null, -32601, `Unknown RPC method: ${request.method}`);
		return;
	}
	try {
		const result = await handler(request.params ?? {});
		sendHttp(res, 200, {
			jsonrpc: "2.0",
			id: request.id ?? null,
			result,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		sendRpcError(res, request.id ?? null, -32000, message);
	}
}

function bearerTokenMatches(auth: string | undefined, token: string): boolean {
	if (!auth?.startsWith("Bearer ")) return false;
	const provided = auth.slice("Bearer ".length);
	const providedBuffer = Buffer.from(provided);
	const tokenBuffer = Buffer.from(token);
	return (
		providedBuffer.length === tokenBuffer.length && timingSafeEqual(providedBuffer, tokenBuffer)
	);
}

function isLoopbackRpcHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return (
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		normalized === "0:0:0:0:0:0:0:1" ||
		normalized === "127.0.0.1" ||
		normalized.startsWith("127.")
	);
}

function parseJsonRpcRequest(raw: string): JsonRpcRequest {
	const parsed = JSON.parse(raw) as Partial<JsonRpcRequest>;
	if (parsed.jsonrpc !== "2.0") throw new Error("jsonrpc must be 2.0");
	if (typeof parsed.method !== "string" || parsed.method.length === 0) {
		throw new Error("method must be a non-empty string");
	}
	if (
		parsed.id !== undefined &&
		parsed.id !== null &&
		typeof parsed.id !== "string" &&
		typeof parsed.id !== "number"
	) {
		throw new Error("id must be a string, number, or null");
	}
	return {
		jsonrpc: "2.0",
		id: parsed.id,
		method: parsed.method,
		params: parsed.params,
	};
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		let body = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk) => {
			size += Buffer.byteLength(chunk);
			if (size > MAX_RPC_BODY_BYTES) {
				reject(new Error("RPC request body too large"));
				req.destroy();
				return;
			}
			body += chunk;
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function sendRpcError(
	res: ServerResponse,
	id: string | number | null,
	code: number,
	message: string,
): void {
	sendHttp(res, 200, {
		jsonrpc: "2.0",
		id,
		error: { code, message },
	});
}

function sendHttp(res: ServerResponse, status: number, body: unknown): void {
	const text = `${JSON.stringify(body)}\n`;
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(text),
	});
	res.end(text);
}

function listenOnHttpEndpoint(server: Server, host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => {
			resolve();
		});
	});
}
