import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { basename } from "node:path";
import { canonicalJson } from "../lib/session-events";
import type { SessionContentPart } from "./base";

export type JsonObject = Record<string, unknown>;

export function jsonObject(value: unknown): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

export function jsonString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function completeJsonlRecords(
	content: string,
): Array<{ data: JsonObject; recordSeq: number }> {
	const records: Array<{ data: JsonObject; recordSeq: number }> = [];
	const physicalLines = content.split("\n");
	for (let recordSeq = 0; recordSeq < physicalLines.length; recordSeq++) {
		const line = physicalLines[recordSeq]?.trim();
		if (!line) continue;
		try {
			const data = jsonObject(JSON.parse(line));
			if (data) records.push({ data, recordSeq });
		} catch {
			// A partially written tail or isolated malformed record is not publishable.
		}
	}
	return records;
}

export function canonicalStructuredString(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		try {
			return canonicalJson(JSON.parse(value));
		} catch {
			return canonicalJson(value);
		}
	}
	return canonicalJson(value);
}

export function stableRecordId(value: JsonObject, recordSeq: number): string {
	for (const candidate of [value.uuid, value.id, jsonObject(value.payload)?.id]) {
		const id = jsonString(candidate);
		if (id) return id;
	}
	return `line-${recordSeq}-${createHash("sha256").update(canonicalJson(value), "ascii").digest("hex").slice(0, 16)}`;
}

const CONTENT_BLOCK_TYPES = new Set([
	"text",
	"input_text",
	"output_text",
	"image",
	"input_image",
	"file",
	"document",
	"thinking",
	"redacted_thinking",
	"reasoning",
]);

const HIDDEN_STRUCTURE_KEYS = new Set([
	"encryptedcontent",
	"encryptedreasoning",
	"redactedthinking",
	"reasoning",
	"signature",
	"thinking",
	"thinkingsignature",
]);

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeExternalUri(value: string | null): string | null {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		if (
			parsed.protocol !== "https:" ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash ||
			isIP(parsed.hostname) !== 0 ||
			parsed.hostname === "localhost" ||
			parsed.hostname.endsWith(".localhost") ||
			parsed.hostname.endsWith(".local")
		) {
			return null;
		}
		return value;
	} catch {
		return null;
	}
}

function localReferenceName(value: string | null): string | null {
	if (!value) return null;
	const normalized = value.replaceAll("\\", "/");
	const name = basename(normalized);
	return name && name !== "." && name !== "/" ? name : null;
}

function uriReferenceName(value: string | null): string | null {
	if (!value) return null;
	try {
		return localReferenceName(decodeURIComponent(new URL(value, "https://invalid.local").pathname));
	} catch {
		return localReferenceName(value);
	}
}

function nonNegativeInteger(...values: unknown[]): number | null {
	for (const value of values) {
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
	}
	return null;
}

function attachmentPart(block: JsonObject): Extract<SessionContentPart, { type: "attachment" }> {
	const source = jsonObject(block.source);
	const rawUri =
		jsonString(block.uri) ??
		jsonString(block.url) ??
		jsonString(block.image_url) ??
		jsonString(source?.url);
	const localPath = jsonString(block.path) ?? jsonString(source?.path);
	const providerRef =
		jsonString(block.provider_ref) ??
		jsonString(block.file_id) ??
		jsonString(block.fileId) ??
		jsonString(source?.file_id);
	const encodedProviderRef = providerRef ? encodeURIComponent(providerRef) : null;
	const providerUri =
		encodedProviderRef && encodedProviderRef.length <= 4000
			? `provider-ref:${encodedProviderRef}`
			: null;
	const safeUri = safeExternalUri(rawUri) ?? providerUri;
	const data = jsonString(block.data) ?? jsonString(source?.data);
	const bytes = data ? Buffer.from(data, "base64") : null;
	const contentSha = bytes ? sha256(bytes) : jsonString(block.sha256);
	const mediaType =
		jsonString(block.media_type) ??
		jsonString(block.mime_type) ??
		jsonString(block.mimeType) ??
		jsonString(source?.media_type);
	const name =
		jsonString(block.name) ??
		jsonString(block.filename) ??
		localReferenceName(localPath) ??
		uriReferenceName(rawUri);
	const sizeBytes = nonNegativeInteger(block.size_bytes, block.size, bytes?.length);
	const identity =
		jsonString(block.id) ??
		providerRef ??
		(contentSha ? `content:${contentSha}` : null) ??
		localPath ??
		rawUri ??
		canonicalJson({
			name,
			media_type: mediaType,
			size_bytes: nonNegativeInteger(block.size_bytes, block.size),
		});
	return {
		type: "attachment",
		attachment_id: `sha256:${sha256(identity)}`,
		availability: safeUri ? "external" : "metadata_only",
		...(safeUri ? { uri: safeUri } : {}),
		...(name ? { name } : {}),
		...(mediaType ? { media_type: mediaType } : {}),
		...(sizeBytes === null ? {} : { size_bytes: sizeBytes }),
		...(contentSha && /^[0-9a-f]{64}$/.test(contentSha) ? { sha256: contentSha } : {}),
	};
}

export function visibleContentParts(content: unknown): SessionContentPart[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	const items = Array.isArray(content) ? content : jsonObject(content) ? [content] : [];
	const parts: SessionContentPart[] = [];
	for (const item of items) {
		const block = jsonObject(item);
		if (!block) continue;
		if (
			(block.type === "text" || block.type === "input_text" || block.type === "output_text") &&
			typeof block.text === "string" &&
			block.text
		) {
			parts.push({ type: "text", text: block.text });
			continue;
		}
		if (!["image", "input_image", "file", "document"].includes(String(block.type))) continue;
		parts.push(attachmentPart(block));
	}
	return parts;
}

function safeToolStructure(value: unknown): unknown | undefined {
	if (Array.isArray(value)) {
		const items = value.map((item) => safeToolStructure(item)).filter((item) => item !== undefined);
		return value.length > 0 && items.length === 0 ? undefined : items;
	}
	const object = jsonObject(value);
	if (!object) return value;
	const type = jsonString(object.type);
	if (type && CONTENT_BLOCK_TYPES.has(type)) return undefined;
	const result: JsonObject = {};
	for (const [key, item] of Object.entries(object)) {
		const normalizedKey = key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
		if (normalizedKey.startsWith("encrypted") || HIDDEN_STRUCTURE_KEYS.has(normalizedKey)) {
			continue;
		}
		const safe = safeToolStructure(item);
		if (safe !== undefined) result[key] = safe;
	}
	return Object.keys(object).length > 0 && Object.keys(result).length === 0 ? undefined : result;
}

export function toolResultContent(
	content: unknown,
	structured: unknown = undefined,
): { parts: SessionContentPart[]; result_json?: string } {
	const parts = visibleContentParts(content);
	if (parts.length === 0 && typeof structured === "string" && structured) {
		parts.push({ type: "text", text: structured });
	}
	const structuredSource = structured === undefined ? content : structured;
	if (typeof structuredSource === "string" || structuredSource === undefined) return { parts };
	const safe = safeToolStructure(structuredSource);
	return safe === undefined ? { parts } : { parts, result_json: canonicalJson(safe) };
}
