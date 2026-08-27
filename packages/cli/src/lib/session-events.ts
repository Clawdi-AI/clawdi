import { createHash } from "node:crypto";
import type { SessionEvent, SessionMessage } from "../adapters/base";

type EventWithoutIdentity<T> = T extends SessionEvent ? Omit<T, "seq" | "event_id"> : never;
export type SessionEventDraft = EventWithoutIdentity<SessionEvent>;

const HEAD_DOMAIN = Buffer.from("clawdi-events-v1\n", "ascii");
export const EMPTY_EVENT_HEAD = createHash("sha256").update(HEAD_DOMAIN).digest("hex");

function asciiJsonString(value: string): string {
	return JSON.stringify(value).replace(
		/[^\x20-\x7e]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/**
 * Clawdi canonical JSON: lexicographic object keys, ASCII JSON strings, and
 * finite JSON numbers. events-v1 itself only contains integers; arbitrary
 * tool payloads are first sealed into canonical JSON strings.
 */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "string") return asciiJsonString(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("events-v1 cannot canonicalize non-finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value !== "object" || value === undefined) {
		throw new Error(`events-v1 cannot canonicalize ${typeof value}`);
	}
	const source = value as Record<string, unknown>;
	const fields: string[] = [];
	for (const key of Object.keys(source).sort()) {
		const item = source[key];
		if (item !== undefined) fields.push(`${asciiJsonString(key)}:${canonicalJson(item)}`);
	}
	return `{${fields.join(",")}}`;
}

export function canonicalPayloadJson(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return canonicalJson(value);
}

export function sequenceSessionEvents(drafts: readonly SessionEventDraft[]): SessionEvent[] {
	return drafts.map((draft, seq) => {
		const eventId = createHash("sha256")
			.update(canonicalJson({ source: draft.source, type: draft.type }), "ascii")
			.digest("hex");
		return { ...draft, seq, event_id: eventId } as SessionEvent;
	});
}

export function projectEventsToMessages(events: readonly SessionEvent[]): SessionMessage[] {
	const messages: SessionMessage[] = [];
	for (const event of events) {
		if (event.type !== "message" || (event.role !== "user" && event.role !== "assistant")) continue;
		if (event.semantics?.display === "hidden") continue;
		const content = event.parts
			.filter(
				(part): part is Extract<(typeof event.parts)[number], { type: "text" }> =>
					part.type === "text",
			)
			.map((part) => part.text)
			.join("\n");
		if (!content) continue;
		messages.push({
			role: event.role,
			content,
			...(event.model ? { model: event.model } : {}),
			...(event.timestamp ? { timestamp: event.timestamp } : {}),
		});
	}
	return messages;
}

export function encodeEventNdjson(events: readonly SessionEvent[]): Buffer {
	return Buffer.from(events.map((event) => `${canonicalJson(event)}\n`).join(""), "ascii");
}

export function advanceEventHead(baseHead: string, events: readonly SessionEvent[]): string {
	let head = Buffer.from(baseHead, "hex");
	if (head.length !== 32) throw new Error("events-v1 base head must be a SHA-256 hex digest");
	for (const event of events) {
		const eventHash = createHash("sha256").update(canonicalJson(event), "ascii").digest();
		head = createHash("sha256").update(head).update(eventHash).digest();
	}
	return head.toString("hex");
}
