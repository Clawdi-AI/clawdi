import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { normalizeApplicationChatJid, normalizeApplicationUserJid } from "./application-jid.js";
import {
	decodeBase64,
	decodeJsonBytes,
	encodeJsonBytes,
	isRecord,
	parseBinaryNode,
	parseStringRecord,
} from "./json-bytes.js";
import {
	type BaileysRuntime,
	QuotedMessageNotFoundError,
	type RelayMessageRequest,
	RuntimeNotConnectedError,
	type SendTextMessageRequest,
} from "./types.js";

export type ServerConfig = {
	apiToken: string;
	maxBodyBytes?: number;
};

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

export function createSidecarServer(runtime: BaileysRuntime, config: ServerConfig): Server {
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
			const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
			if (method === "GET" && path === "/v1/health") {
				writeJson(response, 200, runtime.health());
				return;
			}
			if (method === "POST" && path === "/v1/relay-message") {
				const body = await readJsonBody(request, maxBodyBytes);
				const relayRequest = parseRelayMessageBody(body);
				const messageId = await runtime.relayMessage(relayRequest);
				writeJson(response, 200, { ok: true, messageId });
				return;
			}
			if (method === "POST" && path === "/v1/messages") {
				const body = await readJsonBody(request, maxBodyBytes);
				const result = await runtime.sendTextMessage(parseSendTextMessageBody(body));
				writeJson(response, 200, { ok: true, messageId: result.messageId });
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
			writeJson(response, 404, { error: "not_found" });
		} catch (error: unknown) {
			writeError(response, error);
		}
	});
}

function parseSendTextMessageBody(body: unknown): SendTextMessageRequest {
	if (!isRecord(body)) {
		throw new HttpError(400, "body_must_be_object");
	}
	const jid = normalizeApplicationChatJid(requiredText(body.jid, "jid", 300));
	if (!jid) {
		throw new HttpError(400, "unsupported_jid");
	}
	const text = requiredContentText(body.text, "text", 4096);
	const messageId = requiredText(body.messageId, "messageId", 300);
	if (body.replyTo === undefined) return { jid, text, messageId };
	if (!isRecord(body.replyTo)) {
		throw new HttpError(400, "replyTo_must_be_object");
	}
	const replyMessageId = requiredText(body.replyTo.messageId, "replyTo.messageId", 300);
	const rawParticipantJid = optionalText(
		body.replyTo.participantJid,
		"replyTo.participantJid",
		300,
	);
	const participantJid = rawParticipantJid
		? normalizeApplicationUserJid(rawParticipantJid)
		: undefined;
	if (rawParticipantJid && !participantJid) {
		throw new HttpError(400, "unsupported_participant_jid");
	}
	return {
		jid,
		text,
		messageId,
		replyTo: { messageId: replyMessageId, ...(participantJid ? { participantJid } : {}) },
	};
}

function requiredText(value: unknown, name: string, maxLength: number): string {
	const text = optionalText(value, name, maxLength);
	if (!text) throw new HttpError(400, `${name}_required`);
	return text;
}

function requiredContentText(value: unknown, name: string, maxLength: number): string {
	if (typeof value !== "string") throw new HttpError(400, `${name}_must_be_string`);
	if (!value.trim()) throw new HttpError(400, `${name}_required`);
	if (value.length > maxLength) throw new HttpError(400, `${name}_too_long`);
	return value;
}

function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new HttpError(400, `${name}_must_be_string`);
	const text = value.trim();
	if (!text) return undefined;
	if (text.length > maxLength) throw new HttpError(400, `${name}_too_long`);
	return text;
}

function authorized(request: IncomingMessage, token: string): boolean {
	const header = request.headers.authorization;
	return header === `Bearer ${token}`;
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
		};
	} catch (error: unknown) {
		throw new HttpError(400, error instanceof Error ? error.message : "invalid_relay_message");
	}
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

function writeError(response: ServerResponse, error: unknown): void {
	if (error instanceof HttpError) {
		writeJson(response, error.status, { error: error.message });
		return;
	}
	if (error instanceof RuntimeNotConnectedError) {
		writeJson(response, 503, { error: "baileys_not_connected" });
		return;
	}
	if (error instanceof QuotedMessageNotFoundError) {
		writeJson(response, 404, { error: "quoted_message_not_found" });
		return;
	}
	writeJson(response, 500, {
		error: error instanceof Error ? error.name : "internal_error",
	});
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
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
