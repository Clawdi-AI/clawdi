import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	type ClientRequest,
	createServer,
	type IncomingMessage,
	request,
	type Server,
	type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import { dirname, join, resolve as resolvePath } from "node:path";
import { getDaemonControlDir, getDaemonControlTokenPath } from "./paths";

const MAX_RPC_BODY_BYTES = 1024 * 1024;
export const DEFAULT_CONTROL_RPC_TIMEOUT_MS = 10_000;
export const DEFAULT_CONTROL_RPC_HOST = "127.0.0.1";
export const DEFAULT_CONTROL_RPC_PORT = 17654;

export type ControlRpcHandler = (params: unknown) => Promise<unknown> | unknown;
export type ControlRpcHandlers = Record<string, ControlRpcHandler>;

export interface ControlRpcListenConfig {
	host?: string;
	port?: number;
	allowRemote?: boolean;
	controlDir?: string;
	tokenPath?: string;
}

export interface ControlRpcClientConfig {
	host?: string;
	port?: number;
	token?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: unknown;
}

export interface ControlRpcServer {
	tokenPath: string;
	http: { host: string; port: number };
	rotateToken: () => string;
	close: () => Promise<void>;
}

interface ControlRpcTokenPaths {
	controlDir: string;
	tokenPath: string;
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
				"Use --allow-remote only behind SSH tunneling or a TLS-terminating proxy.",
		);
	}
	const tokenPaths = resolveControlTokenPaths(config);
	ensureControlToken(tokenPaths);
	const httpServer = createServer(async (req, res) => {
		await handleHttpRequest(req, res, handlers, tokenPaths);
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
	let closePromise: Promise<void> | null = null;
	const close = () => {
		closePromise ??= closeServer(httpServer);
		return closePromise;
	};
	abort.addEventListener(
		"abort",
		() => {
			void close();
		},
		{ once: true },
	);
	return {
		tokenPath: tokenPaths.tokenPath,
		http,
		rotateToken: () => rotateControlToken(tokenPaths),
		close,
	};
}

export async function callControlRpc(
	method: string,
	params?: unknown,
	config: ControlRpcClientConfig = {},
): Promise<unknown> {
	const token = config.token ?? process.env.CLAWDI_DAEMON_RPC_TOKEN ?? readControlToken();
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method,
		params: params ?? {},
	});
	const timeoutMs = config.timeoutMs ?? DEFAULT_CONTROL_RPC_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("Control RPC timeout must be a positive number.");
	}
	const response = await new Promise<string>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: { value: string } | { error: unknown }) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			config.signal?.removeEventListener("abort", onAbort);
			if ("error" in result) reject(result.error);
			else resolve(result.value);
		};
		const resolveResponse = (value: string) => finish({ value });
		const rejectResponse = (error: unknown) => finish({ error });
		const req = createServerlessRequest(body, token, config, resolveResponse, rejectResponse);
		const onAbort = () => {
			const error = controlRpcAbortError(config.signal);
			rejectResponse(error);
			req.destroy(error);
		};
		if (config.signal?.aborted) {
			onAbort();
			return;
		}
		config.signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => {
			const error = new Error(`Control RPC timed out after ${timeoutMs}ms.`);
			rejectResponse(error);
			req.destroy(error);
		}, timeoutMs);
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
): ClientRequest {
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
			res.on("aborted", () => reject(new Error("Control RPC response was aborted.")));
			res.on("error", reject);
		},
	);
	req.on("error", reject);
	return req;
}

function controlRpcAbortError(signal: AbortSignal | undefined): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	const error = new Error("Control RPC call aborted.");
	error.name = "AbortError";
	return error;
}

function resolveControlTokenPaths(config: ControlRpcListenConfig): ControlRpcTokenPaths {
	if (config.tokenPath) {
		const tokenParent = dirname(config.tokenPath);
		if (config.controlDir && resolvePath(config.controlDir) !== resolvePath(tokenParent)) {
			throw new Error("daemon control token must be inside the configured control directory");
		}
		return {
			controlDir: tokenParent,
			tokenPath: config.tokenPath,
		};
	}
	if (config.controlDir) {
		return {
			controlDir: config.controlDir,
			tokenPath: join(config.controlDir, "control-token"),
		};
	}
	return {
		controlDir: getDaemonControlDir(),
		tokenPath: getDaemonControlTokenPath(),
	};
}

function ensureControlDir(controlDir: string): void {
	mkdirSync(controlDir, { recursive: true, mode: 0o700 });
	assertSecureControlDirectory(controlDir, currentEffectiveUid());
}

function ensureControlToken(paths = resolveControlTokenPaths({})): string {
	ensureControlDir(paths.controlDir);
	if (pathEntryExists(paths.tokenPath)) {
		return readControlToken(paths);
	}
	return rotateControlToken(paths);
}

export function rotateControlToken(paths = resolveControlTokenPaths({})): string {
	ensureControlDir(paths.controlDir);
	const token = randomBytes(32).toString("hex");
	const temporaryPath = `${paths.tokenPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		writeFileSync(temporaryPath, `${token}\n`, { flag: "wx", mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, paths.tokenPath);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			/* Preserve the original secure-write failure. */
		}
		throw error;
	}
	return readControlToken(paths);
}

function readControlToken(paths = resolveControlTokenPaths({})): string {
	let pathStat: ReturnType<typeof lstatSync>;
	try {
		pathStat = lstatSync(paths.tokenPath);
	} catch (error) {
		if (errnoCode(error) !== "ENOENT") {
			throw new Error(
				`daemon control token at ${paths.tokenPath} could not be inspected: ${errorMessage(error)}`,
			);
		}
		throw new Error(
			`daemon control token not found at ${paths.tokenPath}. Start \`clawdi daemon run\` first.`,
		);
	}
	if (pathStat.isSymbolicLink()) {
		throw new Error(`daemon control token at ${paths.tokenPath} must not be a symbolic link`);
	}

	const effectiveUid = currentEffectiveUid();
	assertSecureControlDirectory(paths.controlDir, effectiveUid);

	let fd: number;
	try {
		fd = openSync(paths.tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const detail =
			errnoCode(error) === "ELOOP" ? "must not be a symbolic link" : errorMessage(error);
		throw new Error(
			`daemon control token at ${paths.tokenPath} could not be opened safely: ${detail}`,
		);
	}
	try {
		const tokenStat = fstatSync(fd);
		if (!tokenStat.isFile()) {
			throw new Error(`daemon control token at ${paths.tokenPath} must be a regular file`);
		}
		assertControlPathOwnershipAndMode(
			"daemon control token",
			paths.tokenPath,
			tokenStat.uid,
			tokenStat.mode,
			effectiveUid,
			0o600,
		);
		const token = readFileSync(fd, "utf-8").trim();
		if (!token) throw new Error(`daemon control token at ${paths.tokenPath} is empty`);
		return token;
	} finally {
		closeSync(fd);
	}
}

function currentEffectiveUid(): number {
	if (typeof process.geteuid !== "function") {
		throw new Error("daemon control RPC requires effective uid ownership checks");
	}
	return process.geteuid();
}

function assertSecureControlDirectory(controlDir: string, effectiveUid: number): void {
	let directoryStat: ReturnType<typeof lstatSync>;
	try {
		directoryStat = lstatSync(controlDir);
	} catch (error) {
		throw new Error(
			`daemon control directory ${controlDir} could not be inspected: ${errorMessage(error)}`,
		);
	}
	if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
		throw new Error(`daemon control directory ${controlDir} must be a real directory`);
	}
	assertControlPathOwnershipAndMode(
		"daemon control directory",
		controlDir,
		directoryStat.uid,
		directoryStat.mode,
		effectiveUid,
		0o700,
	);
}

export function assertControlPathOwnershipAndMode(
	label: string,
	path: string,
	actualUid: number,
	actualMode: number,
	effectiveUid: number,
	requiredMode: number,
): void {
	if (actualUid !== effectiveUid) {
		throw new Error(
			`${label} ${path} must be owned by effective uid ${effectiveUid}; found uid ${actualUid}`,
		);
	}
	const permissions = actualMode & 0o7777;
	if (permissions !== requiredMode) {
		throw new Error(
			`${label} ${path} must have mode ${formatMode(requiredMode)}; found ${formatMode(permissions)}`,
		);
	}
}

function formatMode(mode: number): string {
	return `0${mode.toString(8).padStart(3, "0")}`;
}

function pathEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return false;
		throw error;
	}
}

function errnoCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function handleHttpRequest(
	req: IncomingMessage,
	res: ServerResponse,
	handlers: ControlRpcHandlers,
	tokenPaths: ControlRpcTokenPaths,
): Promise<void> {
	if (req.method !== "POST" || req.url !== "/rpc") {
		sendHttp(res, 404, { error: "not_found" });
		return;
	}
	let token: string;
	try {
		token = readControlToken(tokenPaths);
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

export function isLoopbackRpcHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	const unbracketed =
		normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
	return (
		unbracketed === "localhost" ||
		unbracketed === "::1" ||
		unbracketed === "0:0:0:0:0:0:0:1" ||
		(isIP(unbracketed) === 4 && unbracketed.split(".")[0] === "127")
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
