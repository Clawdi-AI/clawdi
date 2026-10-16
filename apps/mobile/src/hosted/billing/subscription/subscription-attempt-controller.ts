import {
	isDefinitiveRefusal,
	releaseSubscriptionAttempt,
	type SubscriptionAttempt,
} from "@/hosted/billing/subscription/subscription-attempt";

/** The journal's compare-and-set operations (`createSubscriptionAttemptStore`). */
export type SubscriptionJournal = {
	saveAttempt: (
		key: string,
		attempt: SubscriptionAttempt,
		isCurrent: () => boolean,
	) => Promise<void>;
	replaceAttempt: (
		key: string,
		expected: SubscriptionAttempt,
		next: SubscriptionAttempt,
		isCurrent: () => boolean,
	) => Promise<void>;
	clearAttempt: (
		key: string,
		expected: SubscriptionAttempt,
		isCurrent: () => boolean,
	) => Promise<void>;
};

export type SubscriptionAttemptDeps = {
	journal: SubscriptionJournal;
	storageKey: string;
	/** Sends the journaled request exactly as saved. */
	activate: (attempt: SubscriptionAttempt) => Promise<unknown>;
	/** False once the screen or account no longer owns this attempt. */
	isCurrent: () => boolean;
	/** Mirrors each journal write, such as `uncertain` while the POST is in flight. */
	onRecord?: (attempt: SubscriptionAttempt) => void;
};

/**
 * What a send or replay left behind. `attempt` is the journal's current record:
 * - `settled`: hosted activated it and the record was cleared (or will be on reopen);
 * - `released`: hosted proved no dispatch exists; the record awaits a fresh quote;
 * - `failed`: the error, with the record back where it was before a definitively refused
 *   send, or still `uncertain`;
 * - `stale`: the owner changed mid-way; nothing more may be shown or written.
 */
export type SubscriptionAttemptStep =
	| { kind: "settled"; attempt: SubscriptionAttempt }
	| { kind: "released"; attempt: SubscriptionAttempt }
	| { kind: "failed"; attempt: SubscriptionAttempt; error: unknown }
	| { kind: "stale" };

async function settle(
	sent: SubscriptionAttempt,
	deps: SubscriptionAttemptDeps,
): Promise<SubscriptionAttemptStep> {
	try {
		await deps.journal.clearAttempt(deps.storageKey, sent, deps.isCurrent);
	} catch {
		// Hosted holds the activation; a later Check status replays and clears it.
	}
	return deps.isCurrent() ? { kind: "settled", attempt: sent } : { kind: "stale" };
}

/**
 * Sends a `prepared` or `released` record: `uncertain` is written before the POST (a
 * failed write sends nothing). Only a definitive refusal of this send returns the
 * record to its previous state; any other failure leaves it `uncertain`.
 */
async function send(
	saved: SubscriptionAttempt,
	deps: SubscriptionAttemptDeps,
): Promise<SubscriptionAttemptStep> {
	const uncertain: SubscriptionAttempt = { ...saved, submission: "uncertain" };
	await deps.journal.replaceAttempt(deps.storageKey, saved, uncertain, deps.isCurrent);
	if (!deps.isCurrent()) return { kind: "stale" };
	deps.onRecord?.(uncertain);
	try {
		await deps.activate(uncertain);
	} catch (error) {
		if (!deps.isCurrent()) return { kind: "stale" };
		if (!isDefinitiveRefusal(saved, error)) return { kind: "failed", attempt: uncertain, error };
		await deps.journal.replaceAttempt(deps.storageKey, uncertain, saved, deps.isCurrent);
		return deps.isCurrent() ? { kind: "failed", attempt: saved, error } : { kind: "stale" };
	}
	return settle(uncertain, deps);
}

/**
 * Confirms a freshly quoted request: a new one is saved `prepared`, a `prepared` or
 * `released` one takes the fresh quote under the same key; then it is sent.
 */
export async function confirmSubscriptionAttempt(
	previous: SubscriptionAttempt | null,
	next: SubscriptionAttempt,
	deps: SubscriptionAttemptDeps,
): Promise<SubscriptionAttemptStep> {
	if (previous) await deps.journal.replaceAttempt(deps.storageKey, previous, next, deps.isCurrent);
	else await deps.journal.saveAttempt(deps.storageKey, next, deps.isCurrent);
	if (!deps.isCurrent()) return { kind: "stale" };
	deps.onRecord?.(next);
	return send(next, deps);
}

/**
 * Check status for an `uncertain` record: replays the identical request. Hosted returns
 * the original activation if it dispatched; its typed proof of no dispatch, after the
 * grace period, releases the record. Anything else leaves it `uncertain`.
 */
export async function replaySubscriptionAttempt(
	uncertain: SubscriptionAttempt,
	deps: SubscriptionAttemptDeps,
): Promise<SubscriptionAttemptStep> {
	try {
		await deps.activate(uncertain);
	} catch (error) {
		if (!deps.isCurrent()) return { kind: "stale" };
		const released = releaseSubscriptionAttempt(uncertain, error);
		if (!released) return { kind: "failed", attempt: uncertain, error };
		await deps.journal.replaceAttempt(deps.storageKey, uncertain, released, deps.isCurrent);
		return deps.isCurrent() ? { kind: "released", attempt: released } : { kind: "stale" };
	}
	return settle(uncertain, deps);
}
