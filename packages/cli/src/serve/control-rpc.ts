import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type RequestOptions,
	request,
	type Server,
	type ServerResponse,
} from "node:http";
import { type AddressInfo, createConnection } from "node:net";
import {
	getDaemonControlDir,
	getDaemonControlSocketPath,
	getDaemonControlTokenPath,
} from "./paths";

const MAX_RPC_BODY_BYTES = 1024 * 1024;
const SCOPED_TOKEN_PREFIX = "clawdi_rpc_v1_";

export const CONTROL_RPC_CAPABILITIES = [
	"daemon:read",
	"daemon:control",
	"operation:read",
	"operation:control",
	"sync:run",
	"vault:read",
	"vault:write",
	"vault:secrets",
	"auth:read",
	"auth:write",
	"update:read",
	"update:install",
] as const;

export type RpcCapability = (typeof CONTROL_RPC_CAPABILITIES)[number];

export interface ControlRpcAuthContext {
	tokenKind: "root" | "scoped";
	capabilities: readonly RpcCapability[] | "*";
	transport: "socket" | "http";
}

export type ControlRpcHandler = {
	(params: unknown, context?: ControlRpcAuthContext): Promise<unknown> | unknown;
	requiredCapabilities?: readonly RpcCapability[];
	rootOnly?: boolean;
};
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
	socketPath: string;
	tokenPath: string;
	http: { host: string; port: number } | null;
	close: () => Promise<void>;
}

interface ControlRpcEndpoint {
	transport: "socket" | "http";
	requireScopedToken?: boolean;
}

interface ScopedTokenPayload {
	v: 1;
	jti: string;
	iat: number;
	exp?: number;
	cap: RpcCapability[];
	label?: string;
}

export async function startControlRpcServer(
	handlers: ControlRpcHandlers,
	abort: AbortSignal,
	config: ControlRpcListenConfig = {},
): Promise<ControlRpcServer> {
	if (process.platform === "win32") {
		throw new Error("daemon control RPC is not supported on Windows yet");
	}
	if (config.port !== undefined) {
		const host = config.host ?? "127.0.0.1";
		if (config.allowRemote !== true && !isLoopbackRpcHost(host)) {
			throw new Error(
				`Refusing to listen on non-loopback HTTP RPC host ${host}. ` +
					"Use --rpc-allow-remote only behind SSH tunneling or a TLS-terminating proxy.",
			);
		}
	}
	const controlDir = getDaemonControlDir();
	mkdirSync(controlDir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(controlDir, 0o700);
	} catch {
		/* best effort */
	}
	ensureControlToken();
	const socketPath = getDaemonControlSocketPath();
	if (existsSync(socketPath)) {
		if (await socketAcceptsConnections(socketPath)) {
			throw new Error(`daemon control socket already in use at ${socketPath}`);
		}
		unlinkSync(socketPath);
	}

	const socketServer = createServer(async (req, res) => {
		await handleHttpRequest(req, res, handlers, { transport: "socket" });
	});
	await listenOnSocket(socketServer, socketPath);
	try {
		chmodSync(socketPath, 0o600);
	} catch {
		/* best effort */
	}
	let httpServer: Server | null = null;
	let http: { host: string; port: number } | null = null;
	if (config.port !== undefined) {
		const host = config.host ?? "127.0.0.1";
		const requireScopedToken = !isLoopbackRpcHost(host);
		httpServer = createServer(async (req, res) => {
			await handleHttpRequest(req, res, handlers, {
				transport: "http",
				requireScopedToken,
			});
		});
		try {
			await listenOnHttpEndpoint(httpServer, host, config.port);
		} catch (error) {
			await closeServers(socketServer, socketPath, httpServer);
			throw error;
		}
		const address = httpServer.address();
		http = {
			host,
			port: typeof address === "object" && address ? address.port : config.port,
		};
	}
	const close = () => closeServers(socketServer, socketPath, httpServer);
	abort.addEventListener(
		"abort",
		() => {
			void close();
		},
		{ once: true },
	);
	return { socketPath, tokenPath: getDaemonControlTokenPath(), http, close };
}

export async function callControlRpc(
	method: string,
	params?: unknown,
	config: ControlRpcClientConfig = {},
): Promise<unknown> {
	if (config.host !== undefined && config.port === undefined) {
		throw new Error("RPC host requires an RPC port");
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
	const requestOptions: RequestOptions =
		config.host !== undefined || config.port !== undefined
			? {
					hostname: config.host ?? "127.0.0.1",
					port: config.port,
				}
			: {
					socketPath: getDaemonControlSocketPath(),
				};
	const req = request(
		{
			...requestOptions,
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

export function issueScopedControlToken(opts: {
	capabilities: readonly RpcCapability[];
	label?: string;
	expiresInSeconds?: number;
	nowSeconds?: number;
}): { token: string; expires_at: number | null; capabilities: RpcCapability[] } {
	const rootToken = readControlToken();
	const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
	const capabilities = normalizeCapabilities(opts.capabilities);
	const expiresAt =
		opts.expiresInSeconds === undefined ? null : now + Math.max(1, opts.expiresInSeconds);
	const payload: ScopedTokenPayload = {
		v: 1,
		jti: randomBytes(16).toString("hex"),
		iat: now,
		cap: capabilities,
	};
	if (expiresAt !== null) payload.exp = expiresAt;
	if (opts.label) payload.label = opts.label;
	const payloadPart = base64UrlEncode(JSON.stringify(payload));
	const signature = signScopedTokenPayload(payloadPart, rootToken);
	return {
		token: `${SCOPED_TOKEN_PREFIX}${payloadPart}.${signature}`,
		expires_at: expiresAt,
		capabilities,
	};
}

export function withRpcCapabilities(
	handler: ControlRpcHandler,
	capabilities: readonly RpcCapability[],
): ControlRpcHandler {
	handler.requiredCapabilities = capabilities;
	return handler;
}

export function rootOnlyRpcHandler(handler: ControlRpcHandler): ControlRpcHandler {
	handler.rootOnly = true;
	return handler;
}

export function requireRpcCapability(
	context: ControlRpcAuthContext | undefined,
	capability: RpcCapability,
	action: string,
): void {
	if (!hasRpcCapability(context, capability)) {
		throw new Error(`${action} requires RPC capability ${capability}.`);
	}
}

export function hasRpcCapability(
	context: ControlRpcAuthContext | undefined,
	capability: RpcCapability,
): boolean {
	if (!context) return false;
	if (context.capabilities === "*") return true;
	if (context.capabilities.includes(capability)) return true;
	for (const held of context.capabilities) {
		if (capabilityImplications(held).includes(capability)) return true;
	}
	return false;
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
	endpoint: ControlRpcEndpoint,
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
	const authResult = authenticateBearerToken(auth, token, endpoint);
	if (!authResult.ok) {
		sendHttp(res, authResult.status, { error: authResult.error });
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
		assertHandlerAuthorized(handler, authResult.context, request.method);
		const result = await handler(request.params ?? {}, authResult.context);
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

function authenticateBearerToken(
	auth: string | undefined,
	rootToken: string,
	endpoint: ControlRpcEndpoint,
): { ok: true; context: ControlRpcAuthContext } | { ok: false; status: number; error: string } {
	if (!auth?.startsWith("Bearer ")) return { ok: false, status: 401, error: "unauthorized" };
	const provided = auth.slice("Bearer ".length);
	if (tokenMatches(provided, rootToken)) {
		if (endpoint.requireScopedToken) {
			return { ok: false, status: 403, error: "root_token_not_allowed_on_remote_http" };
		}
		return {
			ok: true,
			context: {
				tokenKind: "root",
				capabilities: "*",
				transport: endpoint.transport,
			},
		};
	}
	const scoped = verifyScopedControlToken(provided, rootToken);
	if (!scoped.ok) return { ok: false, status: 401, error: scoped.error };
	return {
		ok: true,
		context: {
			tokenKind: "scoped",
			capabilities: scoped.payload.cap,
			transport: endpoint.transport,
		},
	};
}

function tokenMatches(provided: string, expected: string): boolean {
	const providedBuffer = Buffer.from(provided);
	const expectedBuffer = Buffer.from(expected);
	return (
		providedBuffer.length === expectedBuffer.length &&
		timingSafeEqual(providedBuffer, expectedBuffer)
	);
}

function assertHandlerAuthorized(
	handler: ControlRpcHandler,
	context: ControlRpcAuthContext,
	method: string,
): void {
	if (handler.rootOnly && context.tokenKind !== "root") {
		throw new Error(`${method} requires the daemon root control token.`);
	}
	for (const capability of handler.requiredCapabilities ?? []) {
		requireRpcCapability(context, capability, method);
	}
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

function listenOnSocket(server: Server, socketPath: string): Promise<void> {
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
		server.listen(socketPath);
	});
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

async function closeServers(
	socketServer: Server,
	socketPath: string,
	httpServer: Server | null,
): Promise<void> {
	await Promise.all([closeServer(socketServer), httpServer ? closeServer(httpServer) : undefined]);
	try {
		if (existsSync(socketPath)) unlinkSync(socketPath);
	} catch {
		/* best effort */
	}
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => {
			try {
				const address = server.address() as AddressInfo | string | null;
				if (typeof address === "string" && existsSync(address)) unlinkSync(address);
			} catch {
				/* best effort */
			}
			resolve();
		});
	});
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ path: socketPath });
		const done = (value: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(200);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

function verifyScopedControlToken(
	token: string,
	rootToken: string,
):
	| { ok: true; payload: ScopedTokenPayload }
	| { ok: false; error: "unauthorized" | "scoped_rpc_token_expired" } {
	if (!token.startsWith(SCOPED_TOKEN_PREFIX)) return { ok: false, error: "unauthorized" };
	const body = token.slice(SCOPED_TOKEN_PREFIX.length);
	const parts = body.split(".");
	if (parts.length !== 2) return { ok: false, error: "unauthorized" };
	const [payloadPart, signature] = parts;
	if (!payloadPart || !signature) return { ok: false, error: "unauthorized" };
	const expected = signScopedTokenPayload(payloadPart, rootToken);
	if (!tokenMatches(signature, expected)) return { ok: false, error: "unauthorized" };
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
	} catch {
		return { ok: false, error: "unauthorized" };
	}
	if (!isScopedTokenPayload(payload)) return { ok: false, error: "unauthorized" };
	if (payload.exp !== undefined && payload.exp <= Math.floor(Date.now() / 1000)) {
		return { ok: false, error: "scoped_rpc_token_expired" };
	}
	return { ok: true, payload };
}

function signScopedTokenPayload(payloadPart: string, rootToken: string): string {
	return createHmac("sha256", rootToken).update(payloadPart).digest("base64url");
}

function base64UrlEncode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function isScopedTokenPayload(value: unknown): value is ScopedTokenPayload {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.v !== 1) return false;
	if (typeof record.jti !== "string" || record.jti.length === 0) return false;
	if (typeof record.iat !== "number" || !Number.isInteger(record.iat)) return false;
	if (
		record.exp !== undefined &&
		(typeof record.exp !== "number" || !Number.isInteger(record.exp))
	) {
		return false;
	}
	if (record.label !== undefined && typeof record.label !== "string") return false;
	if (!Array.isArray(record.cap)) return false;
	for (const capability of record.cap) {
		if (!isRpcCapability(capability)) return false;
	}
	return true;
}

function normalizeCapabilities(capabilities: readonly RpcCapability[]): RpcCapability[] {
	const out: RpcCapability[] = [];
	for (const capability of capabilities) {
		if (!isRpcCapability(capability)) {
			throw new Error(`Unknown RPC capability: ${String(capability)}`);
		}
		if (!out.includes(capability)) out.push(capability);
	}
	if (out.length === 0) throw new Error("At least one RPC capability is required.");
	return out;
}

function isRpcCapability(value: unknown): value is RpcCapability {
	return (
		typeof value === "string" && (CONTROL_RPC_CAPABILITIES as readonly string[]).includes(value)
	);
}

function capabilityImplications(capability: RpcCapability): readonly RpcCapability[] {
	switch (capability) {
		case "daemon:control":
			return ["daemon:read"];
		case "operation:control":
			return ["operation:read"];
		case "vault:secrets":
			return ["vault:read"];
		case "auth:write":
			return ["auth:read"];
		case "update:install":
			return ["update:read"];
		default:
			return [];
	}
}
