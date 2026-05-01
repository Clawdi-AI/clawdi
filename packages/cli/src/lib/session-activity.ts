import type { RawSession, SessionMessage } from "../adapters/base";

/**
 * Compute the "user actually used the session last" timestamp for
 * upload to the backend's `last_activity_at` column. Highest-fidelity
 * source first, with fallbacks for adapters whose data shape doesn't
 * carry per-message timestamps.
 *
 * Priority:
 *   1. `max(messages[].timestamp)` — the actual last user / agent
 *      action in the session.
 *   2. `endedAt` — adapter-defined; for adapters that already
 *      compute it as max(message.timestamp) this is identical to
 *      #1, but for adapters that pull `ended_at` from a database
 *      column (Hermes) it can be stale or null.
 *   3. `startedAt` — last-resort lower bound. Always present.
 *
 * Pre-fix `push.ts` and `serve/sync-engine.ts` both used
 * `(endedAt ?? startedAt).toISOString()`, so a Hermes session with
 * a null `ended_at` row in its SQLite db landed `last_activity_at =
 * started_at`, sorting it alongside one-shot sessions even if the
 * user had been actively chatting. Codex flagged this in PR #76
 * round 3.
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
