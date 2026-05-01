/**
 * Bounded persistent retry queue for `clawdi serve`.
 *
 * Daemons need a queue because the network goes away. A skill
 * change happens at T0; the cloud is unreachable for the next 90
 * seconds; the user expects that change to land once we're back
 * online. We log the work item to disk under
 * `<serve-state-dir>/queue.jsonl` so a daemon restart in the
 * middle (PID 1 OOM-killed in a container, laptop sleep, etc.)
 * doesn't drop work either.
 *
 * Bounded — when the queue hits `maxItems`, the oldest entry is
 * evicted to make room for the new one and a `dropped_count`
 * counter ticks up. The dashboard surfaces that counter so a
 * stuck daemon ("queue keeps growing, nothing landing") is
 * visible. Without a bound, a daemon offline overnight would
 * fill the disk.
 *
 * Dedup — if a `skill_push` for the same `skill_key` is already
 * in the queue, we replace it instead of stacking duplicates.
 * The user only ever cares about the latest content; older
 * versions in the queue are dead bytes.
 *
 * NOT a job runner — this module just stores and orders. The
 * sync-engine pops items and decides what to do with them.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log, toErrorMessage } from "./log";
import { getServeStateDir } from "./paths";

type ItemBase = {
	enqueued_at: string;
	attempts: number;
	/** Monotonic generation counter, bumped on every enqueue
	 * (including dedup-replace). The drain loop uses this to
	 * detect "the item I peeked has been replaced while I was
	 * uploading" — without it, dedup + peek/await/markDone has
	 * a window where the watcher can replace the item and
	 * markDone removes the *new* one, silently losing work. */
	version: number;
};

export type QueueItem =
	| (ItemBase & {
			kind: "skill_push";
			skill_key: string;
			// Scope_id this item was enqueued under. Drained items
			// whose stamped scope no longer matches the daemon's
			// current scope are dropped (mid-flight reassignment).
			// Optional for back-compat with queue files written by
			// pre-scope-stamp binaries; the drain loop stamps the
			// current scope when the field is absent so legacy
			// pending work doesn't silently disappear on upgrade.
			scope_id?: string;
			// Hash of what we're about to upload. Distinguishes
			// duplicates: same skill_key with same new_hash = dedup.
			new_hash: string;
	  })
	| (ItemBase & {
			kind: "session_push";
			local_session_id: string;
			content_hash: string;
	  });

/** Distributive `Omit` — TS's built-in `Omit<U, K>` collapses
 * a union into a structural intersection that loses kind-
 * specific keys. The `T extends unknown` clause forces
 * distribution over each variant, preserving narrowing. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** What the caller passes to `enqueue()` — same as a QueueItem
 * minus the `version` field, which the queue stamps itself.
 * Derived from QueueItem so future variants flow through
 * automatically; the previous hand-rolled union had to be
 * updated twice and `stampVersion`'s exhaustiveness check
 * couldn't catch the omission. */
type QueueItemInput = DistributiveOmit<QueueItem, "version">;

const DEFAULT_MAX_ITEMS = 500;

function queuePath(agentType: string): string {
	return join(getServeStateDir(agentType), "queue.jsonl");
}

function ensureDir(p: string) {
	const dir = dirname(p);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Add the queue's `version` stamp to an enqueue input. Switching
 * on `kind` keeps the union arms aligned, so a future variant
 * forces an explicit handler instead of silently flowing through
 * an `as QueueItem` cast. */
function stampVersion(item: QueueItemInput, version: number): QueueItem {
	if (item.kind === "skill_push") return { ...item, version };
	if (item.kind === "session_push") return { ...item, version };
	// Exhaustiveness check — `_x: never` errors at compile time
	// if the union grows without a corresponding arm.
	const _x: never = item;
	throw new Error(`unreachable queue-item kind: ${JSON.stringify(_x)}`);
}

/** Type predicate: narrows a JSON-parsed unknown to a valid
 * QueueItem shape. Returns false for lines from older binaries,
 * hand-edited files, or truncated writes — the load loop skips
 * them and the next persist drops them. Type-predicate form so
 * the value flows through the type system without an `as`. */
function isQueueItem(raw: unknown): raw is QueueItem {
	if (typeof raw !== "object" || raw === null) return false;
	// Record narrowing is the only reasonable way to do indexed
	// reads on `unknown` in TS; it's a structural cast for
	// property access, not a value-narrowing assertion. Each
	// runtime check below is what actually proves the shape.
	const r = raw as Record<string, unknown>;
	if (typeof r.kind !== "string") return false;
	if (typeof r.enqueued_at !== "string") return false;
	if (typeof r.attempts !== "number") return false;
	// `version` is optional for legacy items written by binaries
	// before the version-stamp landed. Reject only on type
	// mismatch (corruption); load() normalizes missing values to
	// 0 so a binary upgrade doesn't silently drop pending work.
	if (r.version !== undefined && typeof r.version !== "number") return false;
	if (r.kind === "skill_push") {
		if (typeof r.skill_key !== "string") return false;
		if (typeof r.new_hash !== "string") return false;
		// Mirror the backend's SKILL_KEY_PATTERN so a queue file
		// persisted before the watcher learned to filter dotfile
		// dirs (`.system`, `.cache`, `.git`) doesn't keep
		// re-attempting a guaranteed 422 on every drain. The
		// load loop drops these silently and the next persist
		// scrubs the file. Allows Hermes-style nested keys
		// (`category/foo`, up to 4 components) so a queued
		// Hermes push survives a daemon restart.
		if (
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}){0,3}$/.test(
				r.skill_key,
			)
		)
			return false;
		// Legacy queue items written by an older binary may not
		// carry `scope_id`. Accept them — the drain loop stamps
		// the current scope before upload, so legacy work doesn't
		// silently disappear after a binary upgrade. Reject only
		// if the field is present but the wrong type (corruption
		// signal, not a back-compat case).
		if (r.scope_id !== undefined && typeof r.scope_id !== "string") return false;
		return true;
	}
	if (r.kind === "session_push") {
		if (typeof r.local_session_id !== "string") return false;
		if (typeof r.content_hash !== "string") return false;
		return true;
	}
	return false;
}

export class RetryQueue {
	private items: QueueItem[] = [];
	private highWater = 0;
	private droppedCount = 0;
	private nextVersion = 1;
	private readonly maxItems: number;
	private readonly agentType: string;
	private readonly onEvict?: (item: QueueItem) => void;
	// Serialize on-disk writes through this chain so concurrent
	// `persist()` calls don't race the rename. The chain is what
	// tests await via `flushPersist()` — production callers are
	// fire-and-forget so the watcher's hot path doesn't block on
	// disk I/O during a burst.
	private writeChain: Promise<void> = Promise.resolve();
	// Latest snapshot waiting to be written. Multiple `persist()`
	// calls within one tick coalesce into a single write because
	// the flush loop reads this until it's null. Last-write-wins,
	// which is what we want — older snapshots have nothing the
	// newer one doesn't.
	private pendingBlob: string | null = null;
	// Snapshot the on-disk path at construction. Resolving via
	// `queuePath()` inside the async flush loop reads the
	// `CLAWDI_STATE_DIR` env var fresh every iteration; tests that
	// mutate that env between cases would otherwise have an
	// in-flight flush from case N race a beforeEach mkdtemp from
	// case N+1 and rename to a torn-down dir. Production callers
	// don't mutate the env mid-process; capturing at construction
	// is safe.
	private readonly persistPath: string;

	constructor(opts: {
		agentType: string;
		maxItems?: number;
		/** Fires once per item evicted by `evictIfFull`. The
		 * sync-engine wires this to clear in-flight session
		 * hashes — without it, an evicted session_push leaves
		 * a stale "this hash is in flight" claim and the
		 * watcher's next tick won't re-enqueue, silently
		 * losing the transcript for the daemon's lifetime. */
		onEvict?: (item: QueueItem) => void;
	}) {
		this.agentType = opts.agentType;
		this.maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
		this.onEvict = opts.onEvict;
		this.persistPath = queuePath(this.agentType);
	}

	/** Read the on-disk queue. Returns an empty queue if the file is
	 * missing or partially corrupted (one bad line skips that line —
	 * we'd rather lose one entry than refuse to start the daemon). */
	load(): void {
		const p = queuePath(this.agentType);
		if (!existsSync(p)) {
			this.items = [];
			return;
		}
		const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
		this.items = [];
		let droppedDuringLoad = 0;
		for (const line of lines) {
			try {
				const parsed: unknown = JSON.parse(line);
				// Type predicate narrows `parsed` to QueueItem after
				// runtime validation — no `as` cast needed. Skipped
				// lines get dropped on the next persist rewrite.
				if (isQueueItem(parsed)) {
					// Normalize: legacy items had no `version` stamp.
					// Treat absent as 0 so the rest of the queue
					// machinery can rely on a number. The reseed
					// step below picks up from max(loaded.version)+1
					// regardless.
					const normalized: QueueItem = {
						...parsed,
						version: parsed.version ?? 0,
					};
					this.items.push(normalized);
				} else {
					droppedDuringLoad += 1;
				}
			} catch {
				droppedDuringLoad += 1;
			}
		}
		// Reseed the version counter past anything we just loaded.
		// Items written by an older binary may not carry `version`;
		// treat those as version 0 and bump from there.
		const maxLoaded = this.items.reduce((m, i) => Math.max(m, i.version ?? 0), 0);
		this.nextVersion = maxLoaded + 1;
		this.highWater = Math.max(this.highWater, this.items.length);
		// Eagerly rewrite the file when we dropped legacy / corrupt
		// lines so they don't sit on disk forever. Without this, an
		// invalid `.system` skill_key persisted by a pre-fix daemon
		// keeps reappearing in the load cycle every restart even if
		// the in-memory items list never tries to drain it (it would,
		// because we'd just put it back in `items` if isQueueItem
		// accepted it). Now that the predicate rejects it, scrub.
		if (droppedDuringLoad > 0) {
			this.persist();
		}
	}

	/** Atomic-replace the on-disk queue. We write the whole file every
	 * time rather than appending — the queue is small enough (≤500
	 * items at ~200B each = 100KB), and a full rewrite avoids the
	 * append-with-truncation footgun where `pop()` requires
	 * out-of-band bookkeeping.
	 *
	 * Snapshotting is synchronous so the on-disk queue reflects the
	 * caller's view of `this.items` AT call time even if a later
	 * mutation lands before the chained write fires. The actual
	 * `writeFile` + `rename` runs async via `writeChain`; callers
	 * don't await — `enqueue()` from the watcher hot path used to
	 * block the event loop on every tick under burst conditions
	 * (50+ skill edits in a second), starving SSE / heartbeat.
	 *
	 * Crash window: an enqueue that happens within ~1ms of a daemon
	 * crash before the chained write completes can be lost. Watcher
	 * re-enqueues on the next file change, and the in-memory item
	 * was already accepted, so the loss is bounded to that single
	 * unfsynced tick — same risk profile as before, just relocated. */
	persist(): void {
		const blob = `${this.items.map((i) => JSON.stringify(i)).join("\n")}${this.items.length > 0 ? "\n" : ""}`;
		this.pendingBlob = blob;
		// If a flush is already running, it'll pick up the new
		// `pendingBlob` on its next loop iteration. Only kick off
		// a fresh flush when no chain exists yet (the chain is
		// only ever resolved when the flush loop fully drained
		// pendingBlob to null).
		this.writeChain = this.writeChain.then(() => this.flushPending());
	}

	/** Drain `pendingBlob` to disk. Loops until it's null so that
	 * a write that lands after this flush started picks up the
	 * latest snapshot in the same flush. */
	private async flushPending(): Promise<void> {
		while (this.pendingBlob !== null) {
			const blob = this.pendingBlob;
			this.pendingBlob = null;
			try {
				ensureDir(this.persistPath);
				const tmp = `${this.persistPath}.tmp`;
				await writeFile(tmp, blob, { mode: 0o600 });
				await rename(tmp, this.persistPath);
			} catch (e) {
				// Persist failures shouldn't crash the daemon — the
				// in-memory queue is still authoritative for the
				// running process. Log and continue; next persist
				// retries.
				log.error("queue.persist_failed", { error: toErrorMessage(e) });
			}
		}
	}

	/** Wait for any in-flight persist to complete. Tests use this to
	 * read the on-disk file after `enqueue()`; the daemon doesn't
	 * call this — its hot paths are fire-and-forget. */
	async flushPersist(): Promise<void> {
		await this.writeChain;
	}

	/** Enqueue OR replace a same-key item. Returns the version
	 * stamp the caller should use later for `markDoneIfVersion`. */
	enqueue(item: QueueItemInput): number {
		const stamped = stampVersion(item, this.nextVersion++);
		// Dedup by (kind, key). For skill_push the key is skill_key;
		// for session_push it's local_session_id. A new entry with
		// the same key replaces the old one (and bumps the version
		// counter) — the user never cares about a stale push when
		// a fresh one is queued.
		const idx = this.items.findIndex((existing) => sameKey(existing, stamped));
		if (idx >= 0) {
			this.items[idx] = stamped;
		} else {
			this.items.push(stamped);
		}
		this.evictIfFull();
		this.highWater = Math.max(this.highWater, this.items.length);
		this.persist();
		return stamped.version;
	}

	private evictIfFull(): void {
		// Eviction priority: drop oldest skill_push first, only fall
		// back to dropping sessions when no skills remain to evict.
		// Skills are content-deduped by skill_key — re-pushing the
		// current state is cheap because the watcher keeps emitting
		// the latest hash. Session content, by contrast, is the
		// agent's transcript history: once dropped from the queue
		// it's gone for the lifetime of this daemon (the in-flight
		// guard holds the hash, the watcher won't re-enqueue).
		// Treating both kinds the same in a FIFO sweep meant a
		// long offline window flooded with skill edits could
		// silently evict pending session uploads. Sessions take
		// a back seat only after we've shed every shedable skill.
		while (this.items.length > this.maxItems) {
			const shedIdx = this.items.findIndex((i) => i.kind === "skill_push");
			let evicted: QueueItem;
			if (shedIdx >= 0) {
				evicted = this.items.splice(shedIdx, 1)[0];
			} else {
				// All sessions, no more skills to drop. Surface this
				// as a `session_drop` so the heartbeat can flag the
				// outlier separately from the routine skill drops.
				evicted = this.items.shift() as QueueItem;
			}
			this.droppedCount += 1;
			// Local observability: a 12h offline window with the
			// queue at cap silently shed N items before this commit
			// — the heartbeat aggregator surfaces the count remotely
			// but no local log fired. warn level + the per-item
			// fields below let `clawdi serve doctor` and journalctl
			// piece together what was lost.
			log.warn("queue.evicted", {
				kind: evicted.kind,
				key: evicted.kind === "skill_push" ? evicted.skill_key : evicted.local_session_id,
				queue_depth: this.items.length,
				dropped_total: this.droppedCount,
			});
			this.onEvict?.(evicted);
		}
	}

	/** Peek without removing — sync-engine calls `markDone(item)` after
	 * a successful upload, or leaves the item in place to retry. */
	peek(): QueueItem | undefined {
		return this.items[0];
	}

	all(): readonly QueueItem[] {
		return this.items;
	}

	/** Remove an item ONLY if its current version matches the one
	 * the caller saw. Prevents the silent-data-loss bug where:
	 *   1. drain peeks item v=5, starts uploading
	 *   2. watcher edits same skill, enqueue replaces with v=6
	 *   3. upload of v=5 finishes; markDone by sameKey would
	 *      drop v=6 even though v=6's content was never pushed.
	 * Returns true if removed, false if superseded. */
	markDoneIfVersion(item: QueueItem): boolean {
		const idx = this.items.findIndex((existing) => sameKey(existing, item));
		if (idx < 0) return false;
		if (this.items[idx].version !== item.version) return false;
		this.items.splice(idx, 1);
		this.persist();
		return true;
	}

	/** Bump the attempts counter on the version-matching item.
	 * If a newer version has replaced it (rare retry race) we
	 * leave the new item alone — its attempts counter restarts
	 * at 0 by design, which is what the caller wants. */
	bumpAttempts(item: QueueItem): void {
		const idx = this.items.findIndex((existing) => sameKey(existing, item));
		if (idx < 0) return;
		if (this.items[idx].version !== item.version) return;
		this.items[idx] = { ...this.items[idx], attempts: this.items[idx].attempts + 1 };
		this.persist();
	}

	get depth(): number {
		return this.items.length;
	}

	get highWaterMark(): number {
		return this.highWater;
	}

	/** Atomic read+reset. The sync-engine reports the delta to the
	 * server in each heartbeat so the dashboard can show "N events
	 * dropped since last heartbeat" without us tracking absolute
	 * counters across daemon restarts. Pair with `restoreDroppedDelta`
	 * if the heartbeat POST fails — otherwise the count is gone. */
	drainDroppedDelta(): number {
		const delta = this.droppedCount;
		this.droppedCount = 0;
		return delta;
	}

	/** Add a previously-drained delta back to the running counter
	 * after a failed heartbeat POST so we don't permanently lose
	 * the count exactly when the network is flakiest. */
	restoreDroppedDelta(delta: number): void {
		if (delta > 0) this.droppedCount += delta;
	}

	/** Record a non-evict drop (4xx permanent error, max-attempts
	 * exhausted). Bumps the same counter as eviction so the
	 * dashboard's "dropped" pill surfaces ALL silent loss
	 * paths uniformly. Pre-fix only FIFO eviction ticked the
	 * counter; a 4xx-rejected session vanished without any UI
	 * signal. */
	recordPermanentDrop(): void {
		this.droppedCount += 1;
	}
}

function sameKey(a: QueueItem, b: QueueItem): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "skill_push" && b.kind === "skill_push") {
		return a.skill_key === b.skill_key;
	}
	if (a.kind === "session_push" && b.kind === "session_push") {
		return a.local_session_id === b.local_session_id;
	}
	return false;
}
