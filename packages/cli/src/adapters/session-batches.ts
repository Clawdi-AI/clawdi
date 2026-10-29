import type { SessionScanBatch } from "./base";

export const SESSION_BATCH_MAX_BYTES = 8 * 1024 * 1024;

/** Bound retained content while allowing a single session to exceed the budget. */
export async function* byteBoundedSessionBatches(
	source: AsyncIterable<SessionScanBatch>,
): AsyncGenerator<SessionScanBatch> {
	let sessions: SessionScanBatch["sessions"] = [];
	let observed: string[] = [];
	let issues: NonNullable<SessionScanBatch["scanIssues"]>[number][] = [];
	let bytes = 0;
	let dedupedCount = 0;
	for await (const batch of source) {
		for (const session of batch.sessions) {
			// Include both projections, and count UTF-8 bytes rather than characters.
			const size = Buffer.byteLength(JSON.stringify([session.events, session.messages]));
			if (sessions.length && bytes + size > SESSION_BATCH_MAX_BYTES) {
				yield { sessions, observedLocalSessionIds: observed, scanIssues: issues, dedupedCount };
				sessions = [];
				observed = [];
				issues = [];
				bytes = 0;
				dedupedCount = 0;
			}
			sessions.push(session);
			bytes += size;
		}
		observed.push(...batch.observedLocalSessionIds);
		issues.push(...(batch.scanIssues ?? []));
		dedupedCount += batch.dedupedCount;
		// Also bound metadata-only batches when every source revision matches.
		if (bytes >= SESSION_BATCH_MAX_BYTES || observed.length >= 128) {
			yield { sessions, observedLocalSessionIds: observed, scanIssues: issues, dedupedCount };
			sessions = [];
			observed = [];
			issues = [];
			bytes = 0;
			dedupedCount = 0;
		}
	}
	if (sessions.length || observed.length || issues.length || dedupedCount)
		yield { sessions, observedLocalSessionIds: observed, scanIssues: issues, dedupedCount };
}
