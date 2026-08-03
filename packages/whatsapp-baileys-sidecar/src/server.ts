import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
	decodeBase64,
	decodeJsonBytes,
	encodeJsonBytes,
	isRecord,
	parseBinaryNode,
	parseStringRecord,
} from "./json-bytes.js";
import { type BaileysSessionSupervisor, InvalidSessionIdError } from "./session-supervisor.js";
import {
	PairingLifecycleError,
	type RelayMessageRequest,
	RuntimeNotConnectedError,
} from "./types.js";

export type ServerConfig = {
	apiToken: string;
	maxBodyBytes?: number;
};

export type SidecarSessionService = Pick<
	BaileysSessionSupervisor,
	"health" | "capabilities" | "session"
>;

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const SESSION_RUNTIME_METHODS = new Map([
	["/v1/health", "GET"],
	["/v1/pairing/status", "GET"],
	["/v1/pairing/qr", "POST"],
	["/v1/pairing/code", "POST"],
	["/v1/pairing/cancel", "POST"],
	["/v1/pairing/logout", "POST"],
	["/v1/pairing/retry", "POST"],
	["/v1/relay-message", "POST"],
	["/v1/raw-node", "POST"],
	["/v1/query-iq", "POST"],
	["/v1/provider-events", "GET"],
	["/v1/provider-events/ack", "POST"],
]);

export function createSidecarServer(
	supervisor: SidecarSessionService,
	config: ServerConfig,
): Server {
	if (!config.apiToken.trim()) {
		throw new Error("apiToken is required");
	}
	const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	return createServer(async (request, response) => {
		try {
			if (!authorized(request, config.apiToken)) {
				writeJson(response, 401, { error: "unauthorized" });
				return;
			}
			const method = request.method ?? "GET";
			let path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
			if (method === "GET" && path === "/v1/health") {
				writeJson(response, 200, supervisor.health());
				return;
			}
			if (method === "GET" && path === "/v1/capabilities") {
				writeJson(response, 200, supervisor.capabilities());
				return;
			}
			const sessionRoute = parseSessionRoute(path);
			if (!sessionRoute) {
				writeJson(response, 404, { error: "not_found" });
				return;
			}
			if (SESSION_RUNTIME_METHODS.get(sessionRoute.runtimePath) !== method) {
				writeJson(response, 404, { error: "not_found" });
				return;
			}
			const runtime = await supervisor.session(sessionRoute.sessionId);
			path = sessionRoute.runtimePath;
			if (method === "GET" && path === "/v1/health") {
				writeJson(response, 200, runtime.health());
				return;
			}
			if (method === "GET" && path === "/v1/pairing/status") {
				writeJson(response, 200, runtime.pairingStatus());
				return;
			}
			if (method === "POST" && path === "/v1/pairing/qr") {
				writeJson(response, 200, await runtime.startQrPairing());
				return;
			}
			if (method === "POST" && path === "/v1/pairing/code") {
				const body = await readJsonBody(request, maxBodyBytes);
				writeJson(response, 200, await runtime.requestPairingCode(parsePhoneNumber(body)));
				return;
			}
			if (method === "POST" && path === "/v1/pairing/cancel") {
				writeJson(response, 200, await runtime.cancelPairing());
				return;
			}
			if (method === "POST" && path === "/v1/pairing/logout") {
				writeJson(response, 200, await runtime.logoutPairing());
				return;
			}
			if (method === "POST" && path === "/v1/pairing/retry") {
				writeJson(response, 200, await runtime.retryPairing());
				return;
			}
			if (method === "POST" && path === "/v1/relay-message") {
				const body = await readJsonBody(request, maxBodyBytes);
				const relayRequest = parseRelayMessageBody(body);
				const messageId = await runtime.relayMessage(relayRequest);
				writeJson(response, 200, { ok: true, messageId });
				return;
			}
			if (method === "POST" && path === "/v1/raw-node") {
				const body = await readJsonBody(request, maxBodyBytes);
				const node = parseNodeBody(body);
				await runtime.sendNode(node);
				writeJson(response, 200, { ok: true });
				return;
			}
			if (method === "POST" && path === "/v1/query-iq") {
				const body = await readJsonBody(request, maxBodyBytes);
				const { node, timeoutMs } = parseQueryBody(body);
				const result = await runtime.query(node, timeoutMs);
				writeJson(response, 200, { node: result === null ? null : encodeJsonBytes(result) });
				return;
			}
			if (method === "GET" && path === "/v1/provider-events") {
				const limit = parseEventLimit(request.url);
				writeJson(response, 200, { events: runtime.providerEvents(limit) });
				return;
			}
			if (method === "POST" && path === "/v1/provider-events/ack") {
				const body = await readJsonBody(request, maxBodyBytes);
				const throughSequence = parseEventAckBody(body);
				runtime.acknowledgeProviderEvents(throughSequence);
				writeJson(response, 200, { ok: true, throughSequence });
				return;
			}
			writeJson(response, 404, { error: "not_found" });
		} catch (error: unknown) {
			writeError(response, error);
		}
	});
}

function parseSessionRoute(path: string): { sessionId: string; runtimePath: string } | undefined {
	const match = /^\/v1\/sessions\/([^/]+)(\/.*)$/.exec(path);
	if (!match) return undefined;
	const sessionId = match[1];
	const suffix = match[2];
	if (!sessionId || !suffix) return undefined;
	return { sessionId, runtimePath: `/v1${suffix}` };
}

function authorized(request: IncomingMessage, token: string): boolean {
	const header = request.headers.authorization;
	if (typeof header !== "string") return false;
	const actual = createHash("sha256").update(header).digest();
	const expected = createHash("sha256").update(`Bearer ${token}`).digest();
	return timingSafeEqual(actual, expected);
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > maxBodyBytes) {
			throw new HttpError(413, "request_body_too_large");
		}
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf-8");
	if (!raw) {
		throw new HttpError(400, "json_body_required");
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new HttpError(400, "invalid_json");
	}
}

function parseRelayMessageBody(body: unknown): RelayMessageRequest {
	if (!isRecord(body)) {
		throw new HttpError(400, "body_must_be_object");
	}
	if (typeof body.jid !== "string" || !body.jid) {
		throw new HttpError(400, "jid_required");
	}
	if (typeof body.messageId !== "string" || !body.messageId) {
		throw new HttpError(400, "messageId_required");
	}
	if (typeof body.messageProtoBase64 !== "string") {
		throw new HttpError(400, "messageProtoBase64_required");
	}
	try {
		return {
			jid: body.jid,
			messageId: body.messageId,
			messageProto: decodeBase64(body.messageProtoBase64, "messageProtoBase64"),
			additionalAttributes: parseStringRecord(
				body.additionalAttributes ?? {},
				"additionalAttributes",
			),
			additionalNodes: parseRelayAdditionalNodes(body.additionalNodes ?? []),
		};
	} catch (error: unknown) {
		throw new HttpError(400, error instanceof Error ? error.message : "invalid_relay_message");
	}
}

function parseRelayAdditionalNodes(value: unknown): RelayMessageRequest["additionalNodes"] {
	if (!Array.isArray(value) || value.length > 1) {
		throw new Error("unsupported_additionalNodes");
	}
	if (value.length === 0) return [];
	const node = value[0];
	if (
		!isRecord(node) ||
		Object.keys(node).some((key) => key !== "tag" && key !== "attrs") ||
		node.tag !== "meta" ||
		!isRecord(node.attrs) ||
		Object.keys(node.attrs).length !== 1 ||
		node.attrs.polltype !== "creation"
	) {
		throw new Error("unsupported_additionalNodes");
	}
	return [{ tag: "meta", attrs: { polltype: "creation" } }];
}

function parsePhoneNumber(body: unknown): string {
	if (!isRecord(body) || typeof body.phoneNumber !== "string") {
		throw new HttpError(400, "phoneNumber_required");
	}
	if (!/^[1-9][0-9]{6,14}$/.test(body.phoneNumber)) {
		throw new HttpError(422, "invalid_phone_number");
	}
	return body.phoneNumber;
}

function parseNodeBody(body: unknown) {
	if (!isRecord(body)) {
		throw new HttpError(400, "body_must_be_object");
	}
	try {
		return parseBinaryNode(decodeJsonBytes(body.node));
	} catch (error: unknown) {
		throw new HttpError(400, error instanceof Error ? error.message : "invalid_node");
	}
}

function parseQueryBody(body: unknown) {
	if (!isRecord(body)) {
		throw new HttpError(400, "body_must_be_object");
	}
	const timeoutMs = body.timeoutMs;
	if (
		!Number.isInteger(timeoutMs) ||
		typeof timeoutMs !== "number" ||
		timeoutMs < 1 ||
		timeoutMs > 120_000
	) {
		throw new HttpError(400, "timeoutMs_must_be_1_to_120000");
	}
	return {
		node: parseNodeBody(body),
		timeoutMs,
	};
}

function parseEventLimit(rawUrl: string | undefined): number {
	const raw = new URL(rawUrl ?? "/", "http://127.0.0.1").searchParams.get("limit") ?? "100";
	const limit = Number(raw);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new HttpError(400, "limit_must_be_1_to_100");
	}
	return limit;
}

function parseEventAckBody(body: unknown): number {
	if (!isRecord(body)) throw new HttpError(400, "body_must_be_object");
	const throughSequence = body.throughSequence;
	if (
		typeof throughSequence !== "number" ||
		!Number.isInteger(throughSequence) ||
		throughSequence < 1
	) {
		throw new HttpError(400, "throughSequence_must_be_positive_integer");
	}
	return throughSequence;
}

function writeError(response: ServerResponse, error: unknown): void {
	if (error instanceof HttpError) {
		writeJson(response, error.status, { error: error.message });
		return;
	}
	if (error instanceof InvalidSessionIdError) {
		writeJson(response, 400, { error: error.message });
		return;
	}
	if (error instanceof RuntimeNotConnectedError) {
		writeJson(response, 503, { error: "baileys_not_connected" });
		return;
	}
	if (error instanceof PairingLifecycleError) {
		writeJson(response, 409, { error: error.message });
		return;
	}
	writeJson(response, 500, {
		error: error instanceof Error ? error.name : "internal_error",
	});
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, {
		"cache-control": "no-store, private",
		"content-type": "application/json; charset=utf-8",
		pragma: "no-cache",
	});
	response.end(JSON.stringify(body));
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}
