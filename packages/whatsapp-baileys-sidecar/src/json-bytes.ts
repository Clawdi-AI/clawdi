import type { BinaryNode } from "baileys";

export const BYTE_SENTINEL = "base64-bytes";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| {
			[key: string]: JsonValue;
	  };

type JsonObject = Record<string, JsonValue>;

export function encodeJsonBytes(value: unknown): JsonValue {
	if (value instanceof Uint8Array) {
		return {
			$type: BYTE_SENTINEL,
			base64: Buffer.from(value).toString("base64"),
		};
	}
	if (Array.isArray(value)) {
		return value.map((item) => encodeJsonBytes(item));
	}
	if (isRecord(value)) {
		const out: JsonObject = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = encodeJsonBytes(item);
		}
		return out;
	}
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (value === undefined) {
		return null;
	}
	return String(value);
}

export function decodeJsonBytes(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => decodeJsonBytes(item));
	}
	if (!isRecord(value)) {
		return value;
	}
	if (value.$type === BYTE_SENTINEL) {
		if (typeof value.base64 !== "string") {
			throw new Error("encoded byte sentinel requires base64 string");
		}
		return decodeBase64(value.base64, "encoded byte sentinel");
	}
	if (value.type === "Buffer" && Array.isArray(value.data)) {
		return Buffer.from(value.data.map((part) => assertByte(part)));
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] = decodeJsonBytes(item);
	}
	return out;
}

export function parseBinaryNode(value: unknown, path = "node"): BinaryNode {
	if (!isRecord(value)) {
		throw new Error(`${path} must be an object`);
	}
	if (typeof value.tag !== "string" || value.tag.length === 0) {
		throw new Error(`${path}.tag must be a non-empty string`);
	}
	const attrs = parseStringRecord(value.attrs, `${path}.attrs`);
	const content = parseBinaryNodeContent(value.content, `${path}.content`);
	if (content === undefined) {
		return { tag: value.tag, attrs };
	}
	return { tag: value.tag, attrs, content };
}

export function decodeBase64(value: string, label: string): Buffer {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
		throw new Error(`${label} must be valid base64`);
	}
	return Buffer.from(value, "base64");
}

export function parseStringRecord(value: unknown, path: string): Record<string, string> {
	if (!isRecord(value)) {
		throw new Error(`${path} must be an object`);
	}
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") {
			throw new Error(`${path}.${key} must be a string`);
		}
		out[key] = item;
	}
	return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBinaryNodeContent(value: unknown, path: string): BinaryNode["content"] | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "string" || value instanceof Uint8Array) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item, index) => parseBinaryNode(item, `${path}[${index}]`));
	}
	throw new Error(`${path} must be a string, bytes, or node array`);
}

function assertByte(value: unknown): number {
	if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 255) {
		throw new Error("Buffer JSON data must contain byte values");
	}
	return value;
}
