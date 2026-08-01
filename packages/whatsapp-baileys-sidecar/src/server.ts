import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ContractValidationError, canonicalRequestHash, parseOperation } from "./contract.js";
import { isE164Digits } from "./jid.js";
import {
	type BaileysRuntime,
	MediaNotFoundError,
	MediaTooLargeError,
	OperationConflictError,
	RuntimeFatalError,
	RuntimeNotConnectedError,
	VersionRecoveryRequiredError,
} from "./types.js";

export type ServerConfig = {
	apiToken: string;
	maxBodyBytes?: number;
};

const DEFAULT_MAX_BODY_BYTES = 12 * 1024 * 1024;

export function createSidecarServer(runtime: BaileysRuntime, config: ServerConfig): Server {
	if (!config.apiToken.trim()) throw new Error("apiToken is required");
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
			if (method === "GET" && path === "/v1/capabilities") {
				writeJson(response, 200, runtime.capabilities());
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
				const body = asRecord(await readJsonBody(request, maxBodyBytes));
				if (typeof body.phoneNumber !== "string" || !isE164Digits(body.phoneNumber)) {
					throw new HttpError(400, "phoneNumber_must_be_e164_digits");
				}
				writeJson(response, 200, await runtime.startCodePairing(body.phoneNumber));
				return;
			}
			if (method === "POST" && path === "/v1/pairing/cancel") {
				writeJson(response, 200, await runtime.cancelPairing());
				return;
			}
			if (method === "POST" && path === "/v1/pairing/logout") {
				writeJson(response, 200, await runtime.logout());
				return;
			}
			if (method === "POST" && path === "/v1/recover") {
				const body = asRecord(await readJsonBody(request, maxBodyBytes));
				if (
					body.acceptVersionChange !== undefined &&
					typeof body.acceptVersionChange !== "boolean"
				) {
					throw new HttpError(400, "acceptVersionChange_must_be_boolean");
				}
				await runtime.recover(body.acceptVersionChange === true);
				writeJson(response, 200, { ok: true });
				return;
			}
			if (method === "POST" && path === "/v1/operations") {
				const operation = parseOperation(await readJsonBody(request, maxBodyBytes));
				const result = await runtime.performOperation(operation, canonicalRequestHash(operation));
				const status =
					result.status === "ambiguous"
						? 409
						: result.status === "failed"
							? result.error === "baileys_not_connected"
								? 503
								: 422
							: 200;
				writeJson(response, status, result);
				return;
			}
			const mediaMatch =
				method === "GET" ? /^\/v1\/media\/(media_[A-Za-z0-9_-]{43})$/.exec(path) : null;
			if (mediaMatch?.[1]) {
				const media = await runtime.downloadMedia(mediaMatch[1]);
				response.writeHead(200, {
					"cache-control": "no-store",
					"content-type": media.contentType,
					"content-length": String(media.data.byteLength),
				});
				response.end(media.data);
				return;
			}
			writeJson(response, 404, { error: "not_found" });
		} catch (error: unknown) {
			writeError(response, error);
		}
	});
}

function authorized(request: IncomingMessage, token: string): boolean {
	const header = request.headers.authorization;
	if (!header?.startsWith("Bearer ")) return false;
	const provided = Buffer.from(header.slice(7));
	const expected = Buffer.from(token);
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.byteLength;
		if (total > maxBodyBytes) throw new HttpError(413, "request_body_too_large");
		chunks.push(buffer);
	}
	if (chunks.length === 0) throw new HttpError(400, "json_body_required");
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "invalid_json");
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HttpError(400, "body_must_be_object");
	}
	return value as Record<string, unknown>;
}

function writeError(response: ServerResponse, error: unknown): void {
	if (error instanceof HttpError) {
		writeJson(response, error.status, { error: error.message });
		return;
	}
	if (error instanceof ContractValidationError) {
		writeJson(response, 400, { error: error.message });
		return;
	}
	if (error instanceof OperationConflictError) {
		writeJson(response, 409, { error: "operation_id_conflict" });
		return;
	}
	if (error instanceof VersionRecoveryRequiredError) {
		writeJson(response, 409, { error: "version_recovery_required" });
		return;
	}
	if (error instanceof RuntimeNotConnectedError) {
		writeJson(response, 503, { error: "baileys_not_connected" });
		return;
	}
	if (error instanceof RuntimeFatalError) {
		writeJson(response, 503, { error: "runtime_fail_stop" });
		return;
	}
	if (error instanceof MediaNotFoundError) {
		writeJson(response, 404, { error: "media_not_found" });
		return;
	}
	if (error instanceof MediaTooLargeError) {
		writeJson(response, 413, { error: "media_too_large" });
		return;
	}
	if (error instanceof Error && error.message === "account_already_linked") {
		writeJson(response, 409, { error: "account_already_linked" });
		return;
	}
	writeJson(response, 500, { error: "internal_error" });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
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
