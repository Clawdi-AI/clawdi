import type { RawSession, SessionMessage, SessionUserActivity } from "../adapters/base";

/**
 * Compute the "user actually used the session last" timestamp for
 * upload to the backend's `last_activity_at` column.
 *
 * Priority:
 *   1. `max(messages[].timestamp)` — the actual last user / agent
 *      action in the session.
 *   2. `endedAt` — adapter-defined. For adapters that already
 *      compute it as max(message.timestamp) this is identical to
 *      #1, but for adapters that pull from a DB column (Hermes)
 *      it can be stale or null.
 *   3. `startedAt` — lower bound; always present.
 *
 * Sharing this between push.ts and sync-engine.ts keeps the two
 * upload paths from diverging — a Hermes session with null
 * `ended_at` would otherwise land `last_activity_at = started_at`,
 * sorting beside one-shot sessions even if the user had been
 * actively chatting.
 */
export function computeLastActivityIso(s: RawSession): string {
	const msgMax = maxMessageTimestamp(s.messages);
	if (msgMax) return msgMax;
	if (s.endedAt) return s.endedAt.toISOString();
	return s.startedAt.toISOString();
}

/** Classify OpenClaw transcript records without losing newer provenance fields. */
export function computeOpenClawRealUserActivity(
	records: readonly unknown[],
	sessionKey: string,
	sessionMetadata?: unknown,
): SessionUserActivity {
	if (isInternalOpenClawSession(sessionKey, sessionMetadata))
		return { lastUserInputAt: null, complete: true };
	let best: number | null = null;
	let complete = true;
	for (const value of records) {
		const record = objectRecord(value);
		if (!record) continue;
		const nested = objectRecord(record.message);
		const message = nested ?? record;
		if (message.role !== "user" || internalOpenClawMessage(message)) continue;
		const { texts, nonText } = openClawContent(message.content);
		if (!nonText && (texts.length === 0 || texts.every(generatedUserText))) continue;
		const timestamp = activityTimestamp(
			message.timestamp ?? message.createdAt ?? record.timestamp ?? record.createdAt,
		);
		if (timestamp === null) {
			complete = false;
			continue;
		}
		if (best === null || timestamp > best) best = timestamp;
	}
	return {
		lastUserInputAt: best === null ? null : new Date(best).toISOString(),
		complete,
	};
}

const INTERNAL_OPENCLAW_SOURCES = new Set([
	"cron",
	"dreaming",
	"subagent",
	"inter_session",
	"internal_system",
	"system_generated",
]);

export function isInternalOpenClawSession(value: string, metadata: unknown): boolean {
	const key = value.trim().toLowerCase();
	if (
		key.startsWith("cron:") ||
		key.includes(":cron:") ||
		key.startsWith("subagent:") ||
		key.includes(":subagent:")
	)
		return true;
	const row = objectRecord(metadata);
	return ["key", "sessionKey", "kind", "source", "origin", "provenance"].some((field) => {
		const candidate = row?.[field];
		return (
			typeof candidate === "string" &&
			INTERNAL_OPENCLAW_SOURCES.has(candidate.trim().toLowerCase().replaceAll("-", "_"))
		);
	});
}

function generatedUserText(value: string): boolean {
	const text = value.trim();
	if (!text) return true;
	if (text === "[OpenClaw heartbeat poll]") return true;
	if (text.startsWith("Delivery:") && text.endsWith("[OpenClaw heartbeat poll]")) return true;
	if (/^\[cron:[^\]]+\]\s*/i.test(text)) return true;
	if (/^System(?: \(untrusted\))?: \[[^\]]+\]\s*/i.test(text)) return true;
	return text.toLowerCase().startsWith("[inter-session message]");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function internalOpenClawMessage(message: Record<string, unknown>): boolean {
	for (const field of ["source", "origin", "provenance", "kind", "type", "channel"]) {
		const value = message[field];
		const record = objectRecord(value);
		const candidates =
			typeof value === "string"
				? [value]
				: record
					? Object.values(record).filter((item): item is string => typeof item === "string")
					: [];
		if (
			candidates.some((item) =>
				INTERNAL_OPENCLAW_SOURCES.has(item.trim().toLowerCase().replaceAll("-", "_")),
			)
		)
			return true;
	}
	return false;
}

function openClawContent(value: unknown): { texts: string[]; nonText: boolean } {
	if (typeof value === "string") return { texts: [value], nonText: false };
	if (!Array.isArray(value)) return { texts: [], nonText: value !== null && value !== undefined };
	const texts: string[] = [];
	let nonText = false;
	for (const part of value) {
		if (typeof part === "string") {
			texts.push(part);
			continue;
		}
		const item = objectRecord(part);
		if (!item) {
			nonText = true;
			continue;
		}
		const kind = typeof item.type === "string" ? item.type.toLowerCase() : "";
		if ((kind === "text" || kind === "input_text") && typeof item.text === "string") {
			texts.push(item.text);
		} else if (!new Set(["tool_result", "thinking", "reasoning"]).has(kind)) {
			nonText = true;
		}
	}
	return { texts, nonText };
}

function activityTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0)
		return value > 100_000_000_000 ? value : value * 1000;
	if (typeof value !== "string" || !value.trim()) return null;
	const numeric = Number(value);
	if (Number.isFinite(numeric) && numeric >= 0)
		return numeric > 100_000_000_000 ? numeric : numeric * 1000;
	const timestamp = new Date(value).getTime();
	return Number.isNaN(timestamp) ? null : timestamp;
}

function maxMessageTimestamp(messages: SessionMessage[]): string | null {
	let best: number | null = null;
	let bestIso: string | null = null;
	for (const m of messages) {
		if (!m.timestamp) continue;
		const t = new Date(m.timestamp).getTime();
		if (Number.isNaN(t)) continue;
		if (best === null || t > best) {
			best = t;
			bestIso = m.timestamp;
		}
	}
	return bestIso;
}
