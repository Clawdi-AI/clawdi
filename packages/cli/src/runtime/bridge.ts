import { createHmac, timingSafeEqual } from "node:crypto";
import { createConnection, createServer, isIP, type Server, type Socket } from "node:net";
import { z } from "zod";
import {
	type RuntimeBridgeSurfaceInput,
	type RuntimeBridgeSurfaceSpec,
	type RuntimeManifest,
	runtimeBridgeSurfaceSchema,
} from "./manifest-contract";

export const RUNTIME_BRIDGE_TOKEN_ENV = "CLAWDI_RUNTIME_BRIDGE_TOKEN";
export const RUNTIME_BRIDGE_COOKIE = "clawdi_runtime_bridge";
export const RUNTIME_BRIDGE_REDEMPTION_QUERY_PARAM = "clawdi_code";
export const RUNTIME_BRIDGE_FRAME_ANCESTORS_ENV = "CLAWDI_RUNTIME_BRIDGE_FRAME_ANCESTORS";
export const RUNTIME_BRIDGE_LISTEN_HOST_ENV = "CLAWDI_RUNTIME_BRIDGE_LISTEN_HOST";
export const RUNTIME_BRIDGE_SURFACES_ENV = "CLAWDI_RUNTIME_BRIDGE_SURFACES";
export const DEFAULT_RUNTIME_BRIDGE_FRAME_ANCESTORS = "'self' https://*.clawdi.ai";

export type RuntimeBridgeSurfaceKind = "control-ui";
const runtimeBridgeRuntimeSurfaceSchema = runtimeBridgeSurfaceSchema.extend({
	listenPort: z.number().int().min(0).max(65535),
});

export interface RuntimeBridgeSurface {
	name: string;
	kind: RuntimeBridgeSurfaceKind;
	listenHost: string;
	listenPort: number;
	upstreamHost: string;
	upstreamPort: number;
}

export interface RuntimeBridgeServer {
	surfaces: RuntimeBridgeSurface[];
	close: () => Promise<void>;
}

export interface RuntimeBridgeOptions {
	token?: string;
	surfaces?: RuntimeBridgeSurfaceInput[];
	frameAncestors?: string;
}

interface ParsedHttpRequest {
	method: string;
	requestTarget: string;
	httpVersion: string;
	headers: Map<string, string[]>;
	rawHeaders: Array<[string, string]>;
}

interface AuthRedeemedCode {
	status: "redeemed-code";
	redirectLocation: string;
}

interface AuthAuthorized {
	status: "authorized";
}

interface AuthUnauthorized {
	status: "unauthorized";
}

type AuthResult = AuthRedeemedCode | AuthAuthorized | AuthUnauthorized;

interface RuntimeBridgeRedemptionState {
	usedJtis: Map<string, number>;
	nowMs: () => number;
}

interface RuntimeBridgeRedemptionClaims {
	jti: string;
	expiresAtMs: number;
	runtime: "openclaw" | "hermes";
}

const HEADER_TIMEOUT_MS = 60_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const HEALTH_CONNECT_TIMEOUT_MS = 1_000;
const MAX_HEADER_BYTES = 64 * 1024;
const BRIDGE_PUBLIC_PREFIX_SCRIPT_PATH = "/__clawdi_runtime_bridge_prefix.js";
const RUNTIME_UI_REDEMPTION_SUBJECT = "v2_hosted_runtime_ui";
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CONTENT_HASHED_ASSET_PATH =
	/^\/(?:assets|static)\/(?:[^/]+\/)*[^/]*-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2|woff|ttf|svg|png|ico|map)$/;
const BRIDGE_PUBLIC_PREFIX_SCRIPT = String.raw`
(() => {
	const script = document.currentScript;
	const scriptUrl = script && script.src ? new URL(script.src, window.location.href) : null;
	const prefix = scriptUrl
		? scriptUrl.pathname.replace(/\/__clawdi_runtime_bridge_prefix\.js$/, "")
		: "";
	if (!prefix || prefix === "/") return;

	const hasPrefix = (path) => path === prefix || path.startsWith(prefix + "/");
	const prefixPath = (path) => {
		if (typeof path !== "string") return path;
		if (!path.startsWith("/") || path.startsWith("//") || hasPrefix(path)) return path;
		return prefix + path;
	};
	const rewriteUrlLike = (value) => {
		if (typeof value === "string") {
			if (value.startsWith("/") && !value.startsWith("//")) return prefixPath(value);
			try {
				const url = new URL(value, window.location.href);
				if (url.host !== window.location.host || hasPrefix(url.pathname)) return value;
				url.pathname = prefixPath(url.pathname);
				return url.href;
			} catch {
				return value;
			}
		}
		if (value instanceof URL && value.host === window.location.host && !hasPrefix(value.pathname)) {
			const url = new URL(value.href);
			url.pathname = prefixPath(url.pathname);
			return url;
		}
		return value;
	};

	const originalPushState = window.history.pushState;
	window.history.pushState = function pushStateWithBridgePrefix(state, unused, url) {
		return originalPushState.call(this, state, unused, url === undefined ? url : rewriteUrlLike(url));
	};
	const originalReplaceState = window.history.replaceState;
	window.history.replaceState = function replaceStateWithBridgePrefix(state, unused, url) {
		return originalReplaceState.call(this, state, unused, url === undefined ? url : rewriteUrlLike(url));
	};

	const originalFetch = window.fetch;
	window.fetch = function fetchWithBridgePrefix(input, init) {
		if (typeof Request !== "undefined" && input instanceof Request) {
			const rewritten = rewriteUrlLike(input.url);
			if (typeof rewritten === "string" && rewritten !== input.url) {
				return originalFetch.call(this, new Request(rewritten, input), init);
			}
		}
		return originalFetch.call(this, rewriteUrlLike(input), init);
	};

	const OriginalWebSocket = window.WebSocket;
	window.WebSocket = class WebSocketWithBridgePrefix extends OriginalWebSocket {
		constructor(url, protocols) {
			super(rewriteUrlLike(url), protocols);
		}
	};

	if (window.EventSource) {
		const OriginalEventSource = window.EventSource;
		window.EventSource = class EventSourceWithBridgePrefix extends OriginalEventSource {
			constructor(url, config) {
				super(rewriteUrlLike(url), config);
			}
		};
	}

	if (window.XMLHttpRequest) {
		const originalOpen = window.XMLHttpRequest.prototype.open;
		window.XMLHttpRequest.prototype.open = function openWithBridgePrefix(method, url, ...rest) {
			return originalOpen.call(this, method, rewriteUrlLike(url), ...rest);
		};
	}
})();
`;
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

export async function startRuntimeBridge(
	options: RuntimeBridgeOptions = {},
): Promise<RuntimeBridgeServer> {
	const token = options.token ?? process.env[RUNTIME_BRIDGE_TOKEN_ENV]?.trim() ?? "";
	const surfaces = resolveRuntimeBridgeSurfaceInputs(
		options.surfaces ?? runtimeBridgeSurfaceInputsFromEnv() ?? [],
	);
	if (surfaces.length === 0) {
		throw new Error("no runtime bridge surfaces configured");
	}
	const frameAncestors =
		options.frameAncestors?.trim() ||
		process.env[RUNTIME_BRIDGE_FRAME_ANCESTORS_ENV]?.trim() ||
		DEFAULT_RUNTIME_BRIDGE_FRAME_ANCESTORS;
	const servers: Server[] = [];
	const listeningSurfaces: RuntimeBridgeSurface[] = [];
	const redemptionState: RuntimeBridgeRedemptionState = {
		usedJtis: new Map(),
		nowMs: () => Date.now(),
	};
	try {
		for (const surface of surfaces) {
			const server = createBridgeServer(surface, token, frameAncestors, redemptionState);
			await listen(server, surface.listenHost, surface.listenPort);
			const address = server.address();
			const listenPort = typeof address === "object" && address ? address.port : surface.listenPort;
			listeningSurfaces.push({ ...surface, listenPort });
			servers.push(server);
		}
	} catch (error) {
		await Promise.allSettled(servers.map((server) => closeServer(server)));
		throw error;
	}
	return {
		surfaces: listeningSurfaces,
		close: async () => {
			await Promise.allSettled(servers.map((server) => closeServer(server)));
		},
	};
}

export function runtimeBridgeSurfaceSpecsForManifest(
	manifest: Pick<RuntimeManifest, "bridge">,
): RuntimeBridgeSurfaceInput[] {
	return manifest.bridge ? [...manifest.bridge.surfaces] : [];
}

export function runtimeBridgeSurfacesForManifest(
	manifest: Pick<RuntimeManifest, "bridge">,
): RuntimeBridgeSurface[] {
	return resolveRuntimeBridgeSurfaceInputs(runtimeBridgeSurfaceSpecsForManifest(manifest));
}

function runtimeBridgeSurfaceInputsFromEnv(): RuntimeBridgeSurfaceInput[] | null {
	const raw = process.env[RUNTIME_BRIDGE_SURFACES_ENV]?.trim();
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`invalid ${RUNTIME_BRIDGE_SURFACES_ENV}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`invalid ${RUNTIME_BRIDGE_SURFACES_ENV}: expected a JSON array`);
	}
	return parsed.map((item, index) => parseRuntimeBridgeSurfaceInput(item, index));
}

function parseRuntimeBridgeSurfaceInput(value: unknown, index: number): RuntimeBridgeSurfaceSpec {
	const parsed = runtimeBridgeSurfaceSchema.safeParse(value);
	if (parsed.success) return parsed.data;
	throw new Error(
		`invalid ${RUNTIME_BRIDGE_SURFACES_ENV}[${index}]: ${parsed.error.issues
			.map((issue) => issue.message)
			.join("; ")}`,
	);
}

function resolveRuntimeBridgeSurfaceInputs(
	inputs: RuntimeBridgeSurfaceInput[],
	defaultListenHost = process.env[RUNTIME_BRIDGE_LISTEN_HOST_ENV]?.trim() || "0.0.0.0",
): RuntimeBridgeSurface[] {
	const seen = new Set<string>();
	return inputs.map((input, index) => {
		const parsed = runtimeBridgeRuntimeSurfaceSchema.safeParse(input);
		if (!parsed.success) {
			throw new Error(
				`invalid runtime bridge surface ${index}: ${parsed.error.issues
					.map((issue) => issue.message)
					.join("; ")}`,
			);
		}
		const surface = {
			...parsed.data,
			listenHost: parsed.data.listenHost?.trim() || defaultListenHost,
			upstreamHost: parsed.data.upstreamHost.trim(),
		};
		const key = `${surface.listenHost}:${surface.listenPort}`;
		if (surface.listenPort !== 0 && seen.has(key)) {
			throw new Error(`duplicate runtime bridge listen address: ${key}`);
		}
		if (surface.listenPort !== 0) seen.add(key);
		return surface;
	});
}

function createBridgeServer(
	surface: RuntimeBridgeSurface,
	token: string,
	frameAncestors: string,
	redemptionState: RuntimeBridgeRedemptionState,
): Server {
	return createServer((clientSocket) => {
		handleClientConnection(surface, token, frameAncestors, redemptionState, clientSocket);
	});
}

function handleClientConnection(
	surface: RuntimeBridgeSurface,
	token: string,
	frameAncestors: string,
	redemptionState: RuntimeBridgeRedemptionState,
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
		handleParsedRequest(
			surface,
			token,
			frameAncestors,
			redemptionState,
			clientSocket,
			parsed,
			remaining,
		);
	};
	clientSocket.on("data", onData);
}

function handleParsedRequest(
	surface: RuntimeBridgeSurface,
	token: string,
	frameAncestors: string,
	redemptionState: RuntimeBridgeRedemptionState,
	clientSocket: Socket,
	parsed: ParsedHttpRequest,
	remaining: Buffer,
): void {
	if (isHealthCheckRequest(parsed)) {
		void respondToHealthCheck(surface, clientSocket);
		return;
	}
	const auth = authenticate(
		parsed.requestTarget,
		parsed.headers,
		token,
		redemptionState,
		surface.name,
	);
	if (auth.status === "redeemed-code") {
		writeRedirectResponse(clientSocket, auth.redirectLocation, token);
		return;
	}
	if (auth.status !== "authorized") {
		writeRawHttpResponse(clientSocket, 401, "Unauthorized", "Unauthorized", [
			["Cache-Control", "no-store"],
		]);
		return;
	}
	if (isBridgePublicPrefixScriptRequest(parsed)) {
		writeBridgePublicPrefixScriptResponse(clientSocket);
		return;
	}
	proxyRawRequest(
		surface,
		frameAncestors,
		publicPathPrefix(parsed.headers),
		clientSocket,
		parsed,
		remaining,
	);
}

async function respondToHealthCheck(
	surface: RuntimeBridgeSurface,
	clientSocket: Socket,
): Promise<void> {
	const healthy = await canConnectToUpstream(surface);
	if (healthy) {
		writeRawHttpResponse(clientSocket, 200, "OK", "OK", [["Cache-Control", "no-store"]]);
		return;
	}
	writeRawHttpResponse(clientSocket, 503, "Service Unavailable", "Service Unavailable", [
		["Cache-Control", "no-store"],
	]);
}

function isHealthCheckRequest(parsed: ParsedHttpRequest): boolean {
	if (parsed.method !== "GET" && parsed.method !== "HEAD") return false;
	const url = requestUrl(parsed.requestTarget);
	return url?.pathname === "/health";
}

function canConnectToUpstream(surface: RuntimeBridgeSurface): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({
			host: surface.upstreamHost,
			port: surface.upstreamPort,
		});
		let done = false;
		const finish = (healthy: boolean) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(healthy);
		};
		const timer = setTimeout(() => finish(false), HEALTH_CONNECT_TIMEOUT_MS);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function proxyRawRequest(
	surface: RuntimeBridgeSurface,
	frameAncestors: string,
	publicPrefix: string,
	clientSocket: Socket,
	parsed: ParsedHttpRequest,
	remaining: Buffer,
): void {
	const upstreamSocket = createConnection({
		host: surface.upstreamHost,
		port: surface.upstreamPort,
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
		if (!isUpgrade) {
			const upstreamPath = requestUrl(proxyPath(parsed.requestTarget))?.pathname ?? "/";
			pipeUpstreamHttpResponse(
				upstreamSocket,
				clientSocket,
				frameAncestors,
				publicPrefix,
				parsed.method,
				upstreamPath,
			);
		}
		upstreamSocket.write(buildProxyRequestHead(parsed, surface));
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
	publicPrefix: string,
	requestMethod: string,
	requestPath: string,
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
		if (shouldRewriteHtmlBody(rawHead, publicPrefix)) {
			const chunks = [remaining];
			upstreamSocket.on("data", (nextChunk) => chunks.push(nextChunk));
			upstreamSocket.once("end", () => {
				const body = rewriteHtmlBody(Buffer.concat(chunks));
				const head = rewriteResponseHeadForFrameEmbedding(
					rawHead,
					frameAncestors,
					requestMethod,
					requestPath,
					body.length,
				);
				clientSocket.end(Buffer.concat([Buffer.from(`${head}\r\n\r\n`, "latin1"), body]));
			});
			upstreamSocket.once("close", () => {
				if (!clientSocket.destroyed && !clientSocket.writableEnded) clientSocket.end();
			});
			return;
		}
		const head = rewriteResponseHeadForFrameEmbedding(
			rawHead,
			frameAncestors,
			requestMethod,
			requestPath,
		);
		clientSocket.write(Buffer.from(`${head}\r\n\r\n`, "latin1"));
		if (remaining.length > 0) clientSocket.write(remaining);
		upstreamSocket.pipe(clientSocket);
	};
	upstreamSocket.on("data", onData);
}

function shouldRewriteHtmlBody(rawHead: string, publicPrefix: string): boolean {
	if (!publicPrefix) return false;
	const lower = rawHead.toLowerCase();
	return (
		lower.includes("content-type: text/html") &&
		!lower.includes("content-encoding:") &&
		!lower.includes("transfer-encoding:")
	);
}

function rewriteHtmlBody(body: Buffer): Buffer {
	const rewritten = body
		.toString("utf8")
		.replace(/\b(href|src)=["']\/(?!\/)/g, (_match, attr: string) => `${attr}="./`);
	const helperTag = `<script src=".${BRIDGE_PUBLIC_PREFIX_SCRIPT_PATH}"></script>`;
	if (rewritten.includes(BRIDGE_PUBLIC_PREFIX_SCRIPT_PATH)) {
		return Buffer.from(rewritten, "utf8");
	}
	if (/<head(?:\s[^>]*)?>/i.test(rewritten)) {
		return Buffer.from(
			rewritten.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${helperTag}`),
			"utf8",
		);
	}
	return Buffer.from(`${helperTag}${rewritten}`, "utf8");
}

function isBridgePublicPrefixScriptRequest(parsed: ParsedHttpRequest): boolean {
	const url = requestUrl(parsed.requestTarget);
	return parsed.method === "GET" && url?.pathname === BRIDGE_PUBLIC_PREFIX_SCRIPT_PATH;
}

function writeBridgePublicPrefixScriptResponse(socket: Socket): void {
	const payload = Buffer.from(BRIDGE_PUBLIC_PREFIX_SCRIPT, "utf8");
	const head = [
		"HTTP/1.1 200 OK",
		"Connection: close",
		"Cache-Control: no-store",
		"Content-Type: application/javascript; charset=utf-8",
		`Content-Length: ${payload.length}`,
		"",
		"",
	].join("\r\n");
	socket.end(Buffer.concat([Buffer.from(head, "latin1"), payload]));
}

function publicPathPrefix(headers: Map<string, string[]>): string {
	const raw = firstHeaderValue(headers, "x-forwarded-prefix");
	if (!raw) return "";
	const prefix = raw.split(",", 1)[0]?.trim().replace(/\/+$/, "") ?? "";
	if (!prefix || prefix === "/" || !prefix.startsWith("/")) return "";
	return prefix;
}

function rewriteResponseHeadForFrameEmbedding(
	rawHead: string,
	frameAncestors: string,
	requestMethod: string,
	requestPath: string,
	contentLength?: number,
): string {
	const lines = rawHead.split("\r\n");
	const statusLine = lines.shift();
	if (!statusLine) return rawHead;
	const output = [statusLine];
	const cspValues: string[] = [];
	let hasCacheControl = false;
	for (const line of lines) {
		const index = line.indexOf(":");
		if (index <= 0) {
			output.push(line);
			continue;
		}
		const name = line.slice(0, index);
		const value = line.slice(index + 1).trimStart();
		const lowerName = name.toLowerCase();
		if (lowerName === "cache-control") hasCacheControl = true;
		if (lowerName === "x-frame-options") continue;
		if (lowerName === "content-security-policy") {
			const sanitized = removeCspDirective(value, "frame-ancestors");
			if (sanitized) cspValues.push(sanitized);
			continue;
		}
		if (contentLength !== undefined && lowerName === "content-length") continue;
		output.push(line);
	}
	if (
		requestMethod === "GET" &&
		/^HTTP\/\d\.\d 200(?: |$)/.test(statusLine) &&
		CONTENT_HASHED_ASSET_PATH.test(requestPath) &&
		!hasCacheControl
	) {
		output.push(`Cache-Control: ${IMMUTABLE_ASSET_CACHE_CONTROL}`);
	}
	for (const value of cspValues) {
		output.push(`Content-Security-Policy: ${value}`);
	}
	output.push(`Content-Security-Policy: frame-ancestors ${frameAncestors}`);
	if (contentLength !== undefined) output.push(`Content-Length: ${contentLength}`);
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
	redemptionState: RuntimeBridgeRedemptionState,
	surfaceName: string,
): AuthResult {
	const url = requestUrl(requestTarget);
	if (!url) return { status: "unauthorized" };
	const redemptionCode = url.searchParams.get(RUNTIME_BRIDGE_REDEMPTION_QUERY_PARAM);
	if (
		redemptionCode &&
		redeemRuntimeBridgeCode(redemptionCode, token, redemptionState, surfaceName)
	) {
		url.searchParams.delete(RUNTIME_BRIDGE_REDEMPTION_QUERY_PARAM);
		const redirectLocation = relativeRedirectLocation(url);
		return { status: "redeemed-code", redirectLocation: redirectLocation || "/" };
	}
	const cookie = parseCookies(headers.get("cookie")).get(RUNTIME_BRIDGE_COOKIE) ?? null;
	if (constantTimeEquals(cookie, token)) return { status: "authorized" };
	return { status: "unauthorized" };
}

function relativeRedirectLocation(url: URL): string {
	if (url.pathname.endsWith("/")) {
		return `.${url.search}`;
	}
	const slash = url.pathname.lastIndexOf("/");
	const basename = url.pathname.slice(slash + 1) || ".";
	return `${basename}${url.search}`;
}

function requestUrl(requestTarget: string): URL | null {
	try {
		return new URL(requestTarget, "http://clawdi-runtime-bridge.local");
	} catch {
		return null;
	}
}

function proxyPath(requestTarget: string): string {
	const url = requestUrl(requestTarget);
	if (!url) return "/";
	url.searchParams.delete(RUNTIME_BRIDGE_REDEMPTION_QUERY_PARAM);
	return `${url.pathname}${url.search}` || "/";
}

function redeemRuntimeBridgeCode(
	code: string,
	token: string,
	state: RuntimeBridgeRedemptionState,
	surfaceName: string,
): boolean {
	const claims = verifyRuntimeBridgeRedemptionCode(code, token, state.nowMs());
	if (!claims) return false;
	if (claims.runtime !== surfaceName) return false;
	pruneUsedRedemptionCodes(state, state.nowMs());
	if (state.usedJtis.has(claims.jti)) return false;
	state.usedJtis.set(claims.jti, claims.expiresAtMs);
	return true;
}

function verifyRuntimeBridgeRedemptionCode(
	code: string,
	token: string,
	nowMs: number,
): RuntimeBridgeRedemptionClaims | null {
	if (!token) return null;
	const parts = code.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	const payloadPart = parts[0];
	const signaturePart = parts[1];
	const expectedSignature = hmacSha256Base64Url(token, payloadPart);
	if (!constantTimeEquals(signaturePart, expectedSignature)) return null;
	const payload = parseRedemptionPayload(payloadPart);
	if (!payload) return null;
	if (payload.expiresAtMs <= nowMs) return null;
	return payload;
}

function parseRedemptionPayload(payloadPart: string): RuntimeBridgeRedemptionClaims | null {
	let raw: unknown;
	try {
		raw = JSON.parse(base64UrlDecode(payloadPart).toString("utf8"));
	} catch {
		return null;
	}
	const parsed = runtimeBridgeRedemptionPayloadSchema.safeParse(raw);
	if (!parsed.success) return null;
	return {
		jti: parsed.data.jti,
		expiresAtMs: parsed.data.exp * 1000,
		runtime: parsed.data.runtime,
	};
}

const runtimeBridgeRedemptionPayloadSchema = z
	.object({
		v: z.literal(1),
		sub: z.literal(RUNTIME_UI_REDEMPTION_SUBJECT),
		deployment_id: z.string().min(1),
		runtime: z.enum(["openclaw", "hermes"]),
		jti: z.string().min(1).max(128),
		iat: z.number().int().nonnegative(),
		exp: z.number().int().nonnegative(),
	})
	.strict();

function pruneUsedRedemptionCodes(state: RuntimeBridgeRedemptionState, nowMs: number): void {
	for (const [jti, expiresAtMs] of state.usedJtis) {
		if (expiresAtMs <= nowMs) state.usedJtis.delete(jti);
	}
}

function hmacSha256Base64Url(token: string, payloadPart: string): string {
	return base64UrlEncode(
		createHmac("sha256", Buffer.from(token, "utf8")).update(payloadPart, "ascii").digest(),
	);
}

function base64UrlEncode(raw: Buffer): string {
	return raw.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value: string): Buffer {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
	return Buffer.from(`${normalized}${padding}`, "base64");
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
	return `${RUNTIME_BRIDGE_COOKIE}=${encodeURIComponent(
		token,
	)}; Secure; HttpOnly; SameSite=Strict; Path=/`;
}

function buildProxyRequestHead(parsed: ParsedHttpRequest, surface: RuntimeBridgeSurface): string {
	const isUpgrade = isUpgradeRequest(parsed.headers);
	const authority = upstreamAuthority(surface);
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
			return name !== RUNTIME_BRIDGE_COOKIE;
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

function upstreamAuthority(surface: RuntimeBridgeSurface): string {
	const host =
		isIP(surface.upstreamHost) === 6 ? `[${surface.upstreamHost}]` : surface.upstreamHost;
	return `${host}:${surface.upstreamPort}`;
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
