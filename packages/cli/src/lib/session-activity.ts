import type { RawSession, SessionMessage } from "../adapters/base";

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
