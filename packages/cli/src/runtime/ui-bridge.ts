import { timingSafeEqual } from "node:crypto";
import { createConnection, createServer, isIP, type Server, type Socket } from "node:net";

export const UI_ACCESS_TOKEN_ENV = "UI_ACCESS_TOKEN";
export const UI_ACCESS_COOKIE = "clawdi_ui";
export const UI_FRAME_ANCESTORS_ENV = "CLAWDI_UI_FRAME_ANCESTORS";
export const UI_BRIDGE_LISTEN_HOST_ENV = "CLAWDI_UI_BRIDGE_LISTEN_HOST";
export const DEFAULT_UI_FRAME_ANCESTORS = "'self' https://*.clawdi.ai";

export interface RuntimeUiBridgeTarget {
	name: string;
	listenHost: string;
	listenPort: number;
	targetHost: string;
	targetPort: number;
}

export interface RuntimeUiBridgeServer {
	targets: RuntimeUiBridgeTarget[];
	close: () => Promise<void>;
}

export interface RuntimeUiBridgeOptions {
	token?: string;
	targets?: RuntimeUiBridgeTarget[];
	frameAncestors?: string;
}

interface ParsedHttpRequest {
	method: string;
	requestTarget: string;
	httpVersion: string;
	headers: Map<string, string[]>;
	rawHeaders: Array<[string, string]>;
}

interface AuthQueryToken {
	status: "query-token";
	redirectLocation: string;
}

interface AuthAuthorized {
	status: "authorized";
}

interface AuthUnauthorized {
	status: "unauthorized";
}

type AuthResult = AuthQueryToken | AuthAuthorized | AuthUnauthorized;

export const DEFAULT_UI_BRIDGE_TARGETS: RuntimeUiBridgeTarget[] = [
	{
		name: "openclaw",
		listenHost: "0.0.0.0",
		listenPort: 18789,
		targetHost: "127.0.0.1",
		targetPort: 18789,
	},
	{
		name: "hermes",
		listenHost: "0.0.0.0",
		listenPort: 9119,
		targetHost: "127.0.0.1",
		targetPort: 9119,
	},
];

const HEADER_TIMEOUT_MS = 60_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 64 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const PROXY_FORWARDING_HEADERS = new Set([
	"forwarded",
	"x-forwarded",
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-port",
	"x-forwarded-proto",
	"x-forwarded-server",
	"x-real-ip",
]);

export async function startRuntimeUiBridge(
	options: RuntimeUiBridgeOptions = {},
): Promise<RuntimeUiBridgeServer> {
	const token = options.token ?? process.env[UI_ACCESS_TOKEN_ENV]?.trim() ?? "";
	const targets = options.targets ?? defaultRuntimeUiBridgeTargets();
	const frameAncestors =
		options.frameAncestors?.trim() ||
		process.env[UI_FRAME_ANCESTORS_ENV]?.trim() ||
		DEFAULT_UI_FRAME_ANCESTORS;
	const servers: Server[] = [];
	const listeningTargets: RuntimeUiBridgeTarget[] = [];
	try {
		for (const target of targets) {
			const server = createBridgeServer(target, token, frameAncestors);
			await listen(server, target.listenHost, target.listenPort);
			const address = server.address();
			const listenPort = typeof address === "object" && address ? address.port : target.listenPort;
			listeningTargets.push({ ...target, listenPort });
			servers.push(server);
		}
	} catch (error) {
		await Promise.allSettled(servers.map((server) => closeServer(server)));
		throw error;
	}
	return {
		targets: listeningTargets,
		close: async () => {
			await Promise.allSettled(servers.map((server) => closeServer(server)));
		},
	};
}

export function defaultRuntimeUiBridgeTargets(): RuntimeUiBridgeTarget[] {
	const listenHost = process.env[UI_BRIDGE_LISTEN_HOST_ENV]?.trim() || "0.0.0.0";
	return DEFAULT_UI_BRIDGE_TARGETS.map((target) => ({ ...target, listenHost }));
}

function createBridgeServer(
	target: RuntimeUiBridgeTarget,
	token: string,
	frameAncestors: string,
): Server {
	return createServer((clientSocket) => {
		handleClientConnection(target, token, frameAncestors, clientSocket);
	});
}

function handleClientConnection(
	target: RuntimeUiBridgeTarget,
	token: string,
	frameAncestors: string,
	clientSocket: Socket,
): void {
	let buffer = Buffer.alloc(0);
	let handled = false;
	clientSocket.setNoDelay(true);
	clientSocket.setTimeout(HEADER_TIMEOUT_MS, () => {
		if (!handled) {
			handled = true;
			writeRawHttpResponse(clientSocket, 408, "Request Timeout", "Request Timeout");
		}
	});
	clientSocket.once("error", () => undefined);
	const onData = (chunk: Buffer) => {
		if (handled) return;
		buffer = Buffer.concat([buffer, chunk]);
		if (buffer.length > MAX_HEADER_BYTES) {
			handled = true;
			clientSocket.off("data", onData);
			writeRawHttpResponse(
				clientSocket,
				431,
				"Request Header Fields Too Large",
				"Request Header Fields Too Large",
			);
			return;
		}
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		handled = true;
		clientSocket.off("data", onData);
		clientSocket.setTimeout(0);
		const rawHead = buffer.subarray(0, headerEnd).toString("latin1");
		const remaining = buffer.subarray(headerEnd + 4);
		const parsed = parseHttpRequestHead(rawHead);
		if (!parsed || !requestUrl(parsed.requestTarget)) {
			writeRawHttpResponse(clientSocket, 400, "Bad Request", "Bad Request");
			return;
		}
		handleParsedRequest(target, token, frameAncestors, clientSocket, parsed, remaining);
	};
	clientSocket.on("data", onData);
}

function handleParsedRequest(
	target: RuntimeUiBridgeTarget,
	token: string,
	frameAncestors: string,
	clientSocket: Socket,
	parsed: ParsedHttpRequest,
	remaining: Buffer,
): void {
	const auth = authenticate(parsed.requestTarget, parsed.headers, token);
	if (auth.status === "query-token") {
		writeRedirectResponse(clientSocket, auth.redirectLocation, token);
		return;
	}
	if (auth.status !== "authorized") {
		writeRawHttpResponse(clientSocket, 401, "Unauthorized", "Unauthorized", [
			["Cache-Control", "no-store"],
		]);
		return;
	}
	proxyRawRequest(target, frameAncestors, clientSocket, parsed, remaining);
}

function proxyRawRequest(
	target: RuntimeUiBridgeTarget,
	frameAncestors: string,
	clientSocket: Socket,
	parsed: ParsedHttpRequest,
	remaining: Buffer,
): void {
	const upstreamSocket = createConnection({
		host: target.targetHost,
		port: target.targetPort,
	});
	const isUpgrade = isUpgradeRequest(parsed.headers);
	let connected = false;
	let failed = false;
	const timer = setTimeout(() => {
		failBeforeConnect(504, "Gateway Timeout");
	}, UPSTREAM_CONNECT_TIMEOUT_MS);
	const failBeforeConnect = (status: number, message: string) => {
		if (failed || connected) return;
		failed = true;
		clearTimeout(timer);
		writeRawHttpResponse(clientSocket, status, message, message);
		upstreamSocket.destroy();
	};
	upstreamSocket.once("connect", () => {
		connected = true;
		clearTimeout(timer);
		if (!isUpgrade) pipeUpstreamHttpResponse(upstreamSocket, clientSocket, frameAncestors);
		upstreamSocket.write(buildProxyRequestHead(parsed, target));
		if (remaining.length > 0) upstreamSocket.write(remaining);
		clientSocket.pipe(upstreamSocket);
		if (isUpgrade) upstreamSocket.pipe(clientSocket);
	});
	upstreamSocket.once("error", () => {
		if (!connected) {
			failBeforeConnect(502, "Bad Gateway");
			return;
		}
		clientSocket.destroy();
	});
	clientSocket.once("error", () => upstreamSocket.destroy());
	clientSocket.once("close", () => upstreamSocket.destroy());
	upstreamSocket.once("close", () => {
		if (!clientSocket.destroyed) clientSocket.end();
	});
}

function pipeUpstreamHttpResponse(
	upstreamSocket: Socket,
	clientSocket: Socket,
	frameAncestors: string,
): void {
	let buffer = Buffer.alloc(0);
	let handled = false;
	const onData = (chunk: Buffer) => {
		if (handled) return;
		buffer = Buffer.concat([buffer, chunk]);
		if (buffer.length > MAX_HEADER_BYTES) {
			handled = true;
			upstreamSocket.off("data", onData);
			upstreamSocket.destroy();
			writeRawHttpResponse(clientSocket, 502, "Bad Gateway", "Bad Gateway");
			return;
		}
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		handled = true;
		upstreamSocket.off("data", onData);
		const rawHead = buffer.subarray(0, headerEnd).toString("latin1");
		const remaining = buffer.subarray(headerEnd + 4);
		const head = rewriteResponseHeadForFrameEmbedding(rawHead, frameAncestors);
		clientSocket.write(Buffer.from(`${head}\r\n\r\n`, "latin1"));
		if (remaining.length > 0) clientSocket.write(remaining);
		upstreamSocket.pipe(clientSocket);
	};
	upstreamSocket.on("data", onData);
}

function rewriteResponseHeadForFrameEmbedding(rawHead: string, frameAncestors: string): string {
	const lines = rawHead.split("\r\n");
	const statusLine = lines.shift();
	if (!statusLine) return rawHead;
	const output = [statusLine];
	const cspValues: string[] = [];
	for (const line of lines) {
		const index = line.indexOf(":");
		if (index <= 0) {
			output.push(line);
			continue;
		}
		const name = line.slice(0, index);
		const value = line.slice(index + 1).trimStart();
		const lowerName = name.toLowerCase();
		if (lowerName === "x-frame-options") continue;
		if (lowerName === "content-security-policy") {
			const sanitized = removeCspDirective(value, "frame-ancestors");
			if (sanitized) cspValues.push(sanitized);
			continue;
		}
		output.push(line);
	}
	for (const value of cspValues) {
		output.push(`Content-Security-Policy: ${value}`);
	}
	output.push(`Content-Security-Policy: frame-ancestors ${frameAncestors}`);
	return output.join("\r\n");
}

function removeCspDirective(value: string, directiveName: string): string {
	const lowerDirectiveName = directiveName.toLowerCase();
	return value
		.split(";")
		.map((directive) => directive.trim())
		.filter((directive) => {
			if (!directive) return false;
			const name = directive.split(/\s+/, 1)[0]?.toLowerCase();
			return name !== lowerDirectiveName;
		})
		.join("; ");
}

function parseHttpRequestHead(rawHead: string): ParsedHttpRequest | null {
	const lines = rawHead.split("\r\n");
	const requestLine = lines.shift();
	if (!requestLine) return null;
	const [method, requestTarget, version, extra] = requestLine.split(" ");
	if (!method || !requestTarget || !version || extra) return null;
	const versionMatch = /^HTTP\/(\d\.\d)$/.exec(version);
	if (!versionMatch) return null;
	const headers = new Map<string, string[]>();
	const rawHeaders: Array<[string, string]> = [];
	for (const line of lines) {
		const index = line.indexOf(":");
		if (index <= 0) return null;
		const name = line.slice(0, index);
		const value = line.slice(index + 1).trimStart();
		const lowerName = name.toLowerCase();
		rawHeaders.push([name, value]);
		const values = headers.get(lowerName) ?? [];
		values.push(value);
		headers.set(lowerName, values);
	}
	return {
		method,
		requestTarget,
		httpVersion: versionMatch[1] ?? "1.1",
		headers,
		rawHeaders,
	};
}

function authenticate(
	requestTarget: string,
	headers: Map<string, string[]>,
	token: string,
): AuthResult {
	const url = requestUrl(requestTarget);
	if (!url) return { status: "unauthorized" };
	const queryToken = url.searchParams.get("t");
	if (constantTimeEquals(queryToken, token)) {
		url.searchParams.delete("t");
		const redirectLocation = `${url.pathname}${url.search}`;
		return { status: "query-token", redirectLocation: redirectLocation || "/" };
	}
	const cookie = parseCookies(headers.get("cookie")).get(UI_ACCESS_COOKIE) ?? null;
	if (constantTimeEquals(cookie, token)) return { status: "authorized" };
	return { status: "unauthorized" };
}

function requestUrl(requestTarget: string): URL | null {
	try {
		return new URL(requestTarget, "http://clawdi-runtime-ui.local");
	} catch {
		return null;
	}
}

function proxyPath(requestTarget: string): string {
	const url = requestUrl(requestTarget);
	if (!url) return "/";
	url.searchParams.delete("t");
	return `${url.pathname}${url.search}` || "/";
}

function parseCookies(values: string[] | undefined): Map<string, string> {
	const result = new Map<string, string>();
	for (const value of values ?? []) {
		for (const part of value.split(/; */)) {
			if (!part) continue;
			const index = part.indexOf("=");
			const name = index === -1 ? part : part.slice(0, index);
			const rawValue = index === -1 ? "" : part.slice(index + 1);
			result.set(name, decodeCookieValue(rawValue));
		}
	}
	return result;
}

function decodeCookieValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function constantTimeEquals(input: string | null | undefined, expected: string): boolean {
	if (!input || !expected) return false;
	const inputBuffer = Buffer.from(input);
	const expectedBuffer = Buffer.from(expected);
	const length = Math.max(inputBuffer.length, expectedBuffer.length);
	const paddedInput = Buffer.alloc(length);
	const paddedExpected = Buffer.alloc(length);
	inputBuffer.copy(paddedInput);
	expectedBuffer.copy(paddedExpected);
	return (
		timingSafeEqual(paddedInput, paddedExpected) && inputBuffer.length === expectedBuffer.length
	);
}

function sessionCookie(token: string): string {
	return `${UI_ACCESS_COOKIE}=${encodeURIComponent(
		token,
	)}; Secure; HttpOnly; SameSite=Strict; Path=/`;
}

function buildProxyRequestHead(parsed: ParsedHttpRequest, target: RuntimeUiBridgeTarget): string {
	const isUpgrade = isUpgradeRequest(parsed.headers);
	const authority = targetAuthority(target);
	const origin = `http://${authority}`;
	let originWritten = false;
	let refererWritten = false;
	const lines = [
		`${parsed.method} ${proxyPath(parsed.requestTarget)} HTTP/${parsed.httpVersion}`,
		`Host: ${authority}`,
		isUpgrade ? "Connection: Upgrade" : "Connection: close",
	];
	const upgradeValue = firstHeaderValue(parsed.headers, "upgrade");
	if (isUpgrade) lines.push(`Upgrade: ${upgradeValue || "websocket"}`);
	for (const [name, value] of parsed.rawHeaders) {
		const lowerName = name.toLowerCase();
		if (isProxyForwardingHeader(lowerName)) continue;
		if (lowerName === "host" || HOP_BY_HOP_HEADERS.has(lowerName)) continue;
		if (lowerName === "origin") {
			if (!originWritten) {
				lines.push(`Origin: ${origin}`);
				originWritten = true;
			}
			continue;
		}
		if (lowerName === "referer") {
			if (!refererWritten) {
				lines.push(`Referer: ${rewriteReferer(value, origin)}`);
				refererWritten = true;
			}
			continue;
		}
		if (lowerName === "cookie") {
			const sanitizedCookie = removeBridgeCookie(value);
			if (sanitizedCookie) lines.push(`Cookie: ${sanitizedCookie}`);
			continue;
		}
		lines.push(`${name}: ${value}`);
	}
	return `${lines.join("\r\n")}\r\n\r\n`;
}

function isProxyForwardingHeader(lowerName: string): boolean {
	return (
		PROXY_FORWARDING_HEADERS.has(lowerName) ||
		lowerName.startsWith("x-forwarded-") ||
		lowerName.startsWith("cf-")
	);
}

function isUpgradeRequest(headers: Map<string, string[]>): boolean {
	const upgradeValue = firstHeaderValue(headers, "upgrade");
	if (!upgradeValue) return false;
	return (headers.get("connection") ?? []).some((value) =>
		value
			.split(",")
			.map((part) => part.trim().toLowerCase())
			.includes("upgrade"),
	);
}

function firstHeaderValue(headers: Map<string, string[]>, name: string): string | undefined {
	return headers.get(name.toLowerCase())?.[0];
}

function removeBridgeCookie(value: string): string {
	return value
		.split(/; */)
		.filter((part) => {
			if (!part) return false;
			const index = part.indexOf("=");
			const name = (index === -1 ? part : part.slice(0, index)).trim();
			return name !== UI_ACCESS_COOKIE;
		})
		.join("; ");
}

function rewriteReferer(value: string, origin: string): string {
	try {
		const url = new URL(value);
		return `${origin}${url.pathname}${url.search}`;
	} catch {
		return `${origin}/`;
	}
}

function targetAuthority(target: RuntimeUiBridgeTarget): string {
	const host = isIP(target.targetHost) === 6 ? `[${target.targetHost}]` : target.targetHost;
	return `${host}:${target.targetPort}`;
}

function writeRedirectResponse(socket: Socket, location: string, token: string): void {
	writeRawHttpResponse(socket, 302, "Found", "", [
		["Cache-Control", "no-store"],
		["Location", location],
		["Set-Cookie", sessionCookie(token)],
	]);
}

function writeRawHttpResponse(
	socket: Socket,
	status: number,
	message: string,
	body: string,
	headers: Array<[string, string]> = [],
): void {
	if (socket.destroyed) return;
	const payload = Buffer.from(body);
	const head = [
		`HTTP/1.1 ${status} ${message}`,
		"Connection: close",
		"Content-Type: text/plain; charset=utf-8",
		...headers.map(([name, value]) => `${name}: ${value}`),
		`Content-Length: ${payload.length}`,
		"",
		"",
	].join("\r\n");
	socket.end(Buffer.concat([Buffer.from(head), payload]));
}

function listen(server: Server, host: string, port: number): Promise<void> {
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
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
