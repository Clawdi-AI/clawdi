/**
 * Smoke tests for the serve retry queue.
 *
 * No network, no daemon — just exercise enqueue / persist / load /
 * dedup / eviction in isolation. Catches the "we wrote a JSON
 * file the next process can't parse" class of bug before a real
 * daemon hits it in the wild.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetryQueue } from "./queue";

const tmp = mkdtempSync(join(tmpdir(), "clawdi-queue-test-"));
const originalStateDir = process.env.CLAWDI_STATE_DIR;

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
	if (originalStateDir === undefined) delete process.env.CLAWDI_STATE_DIR;
	else process.env.CLAWDI_STATE_DIR = originalStateDir;
});

beforeEach(() => {
	// Each test gets a fresh state dir so they don't see each
	// other's persisted queues.
	const dir = mkdtempSync(join(tmp, "case-"));
	process.env.CLAWDI_STATE_DIR = dir;
});

describe("RetryQueue", () => {
	it("persists and reloads items across instances", async () => {
		const a = new RetryQueue({ agentType: "claude_code" });
		a.enqueue({
			kind: "skill_push",
			scope_id: "test-scope",
			skill_key: "alpha",
			new_hash: "h1",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
		});
		// Persist is async fire-and-forget on the hot path so the
		// daemon doesn't block on disk I/O during a watcher burst.
		// Tests that read from disk must drain the write chain
		// before constructing the second queue instance.
		await a.flushPersist();
		expect(a.depth).toBe(1);

		const b = new RetryQueue({ agentType: "claude_code" });
		b.load();
		expect(b.depth).toBe(1);
		expect(b.peek()?.kind).toBe("skill_push");
	});

	it("dedups by skill_key — newer entry replaces older", () => {
		const q = new RetryQueue({ agentType: "claude_code" });
		q.enqueue({
			kind: "skill_push",
			scope_id: "test-scope",
			skill_key: "alpha",
			new_hash: "h1",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
		});
		q.enqueue({
			kind: "skill_push",
			scope_id: "test-scope",
			skill_key: "alpha",
			new_hash: "h2",
			enqueued_at: "2026-01-01T00:00:01Z",
			attempts: 0,
		});
		expect(q.depth).toBe(1);
		const front = q.peek();
		if (front?.kind !== "skill_push") throw new Error("expected skill_push");
		expect(front.new_hash).toBe("h2");
	});

	it("evicts oldest when over maxItems and counts the drop", () => {
		const q = new RetryQueue({ agentType: "claude_code", maxItems: 2 });
		for (const k of ["a", "b", "c"]) {
			q.enqueue({
				kind: "skill_push",
				scope_id: "test-scope",
				skill_key: k,
				new_hash: `${k}-h`,
				enqueued_at: "2026-01-01T00:00:00Z",
				attempts: 0,
			});
		}
		expect(q.depth).toBe(2);
		expect(q.drainDroppedDelta()).toBe(1);
		expect(q.drainDroppedDelta()).toBe(0); // delta resets after read
	});

	it("markDoneIfVersion removes the item when version matches", () => {
		const q = new RetryQueue({ agentType: "claude_code" });
		q.enqueue({
			kind: "skill_push",
			scope_id: "test-scope",
			skill_key: "alpha",
			new_hash: "h1",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
		});
		const live = q.peek();
		if (!live) throw new Error("expected item in queue");
		expect(q.markDoneIfVersion(live)).toBe(true);
		expect(q.depth).toBe(0);
	});

	it("markDoneIfVersion is a no-op if a newer version replaced the item", () => {
		// Repro the silent-data-loss bug: drain takes v=N, watcher
		// enqueues v=N+1, drain's later markDone must NOT delete
		// the new item.
		const q = new RetryQueue({ agentType: "claude_code" });
		q.enqueue({
			kind: "skill_push",
			scope_id: "test-scope",
			skill_key: "alpha",
			new_hash: "h1",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
		});
		const drained = q.peek();
		if (!drained) throw new Error("expected item");
		// While the drain is "uploading", the watcher fires again.
		q.enqueue({
			kind: "skill_push",
			scope_id: "test-scope",
			skill_key: "alpha",
			new_hash: "h2",
			enqueued_at: "2026-01-01T00:00:01Z",
			attempts: 0,
		});
		// Drain finishes — markDone must reject the stale version.
		expect(q.markDoneIfVersion(drained)).toBe(false);
		expect(q.depth).toBe(1);
		const front = q.peek();
		if (front?.kind !== "skill_push") throw new Error("expected skill_push");
		expect(front.new_hash).toBe("h2");
	});

	it("bumpAttempts increments the counter and persists", async () => {
		const q = new RetryQueue({ agentType: "claude_code" });
		q.enqueue({
			kind: "skill_push",
			scope_id: "test-scope",
			skill_key: "alpha",
			new_hash: "h1",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
		});
		// bumpAttempts is called from the drain loop with the
		// version-stamped item it peeked.
		const live = q.peek();
		if (!live) throw new Error("expected item");
		q.bumpAttempts(live);
		const live2 = q.peek();
		if (!live2) throw new Error("expected item");
		q.bumpAttempts(live2);
		const front = q.peek();
		if (front?.kind !== "skill_push") throw new Error("expected skill_push");
		expect(front.attempts).toBe(2);
		// persist() is async fire-and-forget; flush before reading
		// the on-disk file from a sibling instance.
		await q.flushPersist();

		const reloaded = new RetryQueue({ agentType: "claude_code" });
		reloaded.load();
		const front2 = reloaded.peek();
		if (front2?.kind !== "skill_push") throw new Error("expected skill_push");
		expect(front2.attempts).toBe(2);
	});

	it("survives a corrupt line in the on-disk file", async () => {
		const q = new RetryQueue({ agentType: "claude_code" });
		q.enqueue({
			kind: "skill_push",
			scope_id: "test-scope",
			skill_key: "alpha",
			new_hash: "h1",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
		});
		// Drain the persist chain so the file actually exists
		// before we try to corrupt it. Without this, appendFileSync
		// races the async write and the corruption either lands in
		// the wrong file or the queue file gets re-written after
		// our append, blowing away the test setup.
		await q.flushPersist();
		// Append a garbage line to the queue file, simulating a
		// crash mid-write or a partial fsync. load() should drop
		// the bad line and keep the good one.
		// Per-agent path: the queue lives under
		// <CLAWDI_STATE_DIR>/<agent>/queue.jsonl, not in the
		// state-dir root. The test must hit the same path the
		// production code writes to or the corruption it injects
		// goes into a file the queue never reads.
		const path = join(process.env.CLAWDI_STATE_DIR ?? tmp, "claude_code", "queue.jsonl");
		appendFileSync(path, "this-is-not-json\n");

		const reloaded = new RetryQueue({ agentType: "claude_code" });
		reloaded.load();
		expect(reloaded.depth).toBe(1);
	});

	it("loads legacy skill_push items written without scope_id", () => {
		// Pre-scope-stamp daemon binaries persisted skill_push items
		// without a `scope_id` field. After upgrade, those items
		// must NOT silently disappear — `isQueueItem` accepts the
		// missing field, and the drain loop stamps the current
		// scope before upload. Without this back-compat, a daemon
		// upgrading mid-flight would lose every queued offline edit.
		const path = join(process.env.CLAWDI_STATE_DIR ?? tmp, "claude_code", "queue.jsonl");
		const dir = join(process.env.CLAWDI_STATE_DIR ?? tmp, "claude_code");
		mkdirSync(dir, { recursive: true });
		const legacy = JSON.stringify({
			kind: "skill_push",
			skill_key: "legacy-x",
			new_hash: "abc123",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
			version: 1,
			// no scope_id field
		});
		writeFileSync(path, `${legacy}\n`);

		const q = new RetryQueue({ agentType: "claude_code" });
		q.load();
		expect(q.depth).toBe(1);
		const item = q.peek();
		expect(item?.kind).toBe("skill_push");
		expect(item && "scope_id" in item ? item.scope_id : undefined).toBeUndefined();
		// Sanity: the skill_key survived load.
		expect(item && "skill_key" in item ? item.skill_key : undefined).toBe("legacy-x");
	});

	it("scrubs queued items whose skill_key violates the backend pattern", () => {
		// Pre-fix daemons watched every subdir under the skills root,
		// including dotfile entries like `.system`. Those got pushed,
		// the backend 422'd them on every drain, and the queue file
		// grew "permanent error" entries that were impossible to clean
		// without manually editing `~/.clawdi/serve/<agent>/queue.jsonl`.
		// Load now rejects them via the SKILL_KEY_PATTERN check AND
		// rewrites the file so the bad lines don't sit on disk forever.
		const stateDir = process.env.CLAWDI_STATE_DIR ?? tmp;
		const path = join(stateDir, "claude_code", "queue.jsonl");
		mkdirSync(join(stateDir, "claude_code"), { recursive: true });
		const lines = [
			JSON.stringify({
				kind: "skill_push",
				skill_key: ".system",
				new_hash: "h-bad",
				scope_id: "s",
				enqueued_at: "2026-01-01T00:00:00Z",
				attempts: 0,
				version: 1,
			}),
			JSON.stringify({
				kind: "skill_push",
				skill_key: "legit-skill",
				new_hash: "h-good",
				scope_id: "s",
				enqueued_at: "2026-01-01T00:00:00Z",
				attempts: 0,
				version: 2,
			}),
		].join("\n");
		writeFileSync(path, `${lines}\n`);

		const q = new RetryQueue({ agentType: "claude_code" });
		q.load();
		expect(q.depth).toBe(1);
		const item = q.peek();
		if (item?.kind !== "skill_push") throw new Error("expected skill_push");
		expect(item.skill_key).toBe("legit-skill");

		// Re-load from disk: the eager persist should have already
		// scrubbed the bad line, so a second daemon boot finds only
		// the legit entry on disk.
		const q2 = new RetryQueue({ agentType: "claude_code" });
		q2.load();
		expect(q2.depth).toBe(1);
		const item2 = q2.peek();
		if (item2?.kind !== "skill_push") throw new Error("expected skill_push");
		expect(item2.skill_key).toBe("legit-skill");
	});

	it("eviction prefers skill_push over session_push", () => {
		// Per round-5 must-have: session content is lossless;
		// only skill_push should get FIFO-evicted when the queue
		// is full. Without this rule a long offline window
		// flooded with skill edits silently evicts pending
		// session uploads and the transcript history is gone.
		const q = new RetryQueue({ agentType: "claude_code", maxItems: 2 });
		q.enqueue({
			kind: "session_push",
			local_session_id: "s1",
			content_hash: "h1",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
		});
		q.enqueue({
			kind: "skill_push",
			scope_id: "s",
			skill_key: "alpha",
			new_hash: "ha",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
		});
		q.enqueue({
			kind: "skill_push",
			scope_id: "s",
			skill_key: "beta",
			new_hash: "hb",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
		});
		// One was evicted to keep depth at 2. The session must
		// survive; the oldest skill (alpha) is the one to go.
		expect(q.depth).toBe(2);
		expect(q.drainDroppedDelta()).toBe(1);
		const all = q.all();
		const kinds = all.map((i) => i.kind).sort();
		expect(kinds).toEqual(["session_push", "skill_push"]);
		const skill = all.find((i) => i.kind === "skill_push");
		if (skill?.kind !== "skill_push") throw new Error("expected skill_push");
		expect(skill.skill_key).toBe("beta");
	});

	it("onEvict callback fires once per evicted item", () => {
		// Sync-engine wires onEvict to clear inFlightSessionHash
		// when a session_push gets evicted. Without that hook the
		// dedup map keeps the dropped session out forever — silent
		// permanent loss for the daemon's lifetime.
		const evicted: string[] = [];
		const q = new RetryQueue({
			agentType: "claude_code",
			maxItems: 1,
			onEvict: (item) => {
				if (item.kind === "session_push") {
					evicted.push(`session:${item.local_session_id}`);
				} else {
					evicted.push(`skill:${item.skill_key}`);
				}
			},
		});
		q.enqueue({
			kind: "session_push",
			local_session_id: "alpha",
			content_hash: "h1",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
		});
		q.enqueue({
			kind: "session_push",
			local_session_id: "beta",
			content_hash: "h2",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
		});
		// `beta` filled the cap; `alpha` got evicted. The callback
		// must have fired exactly once for it.
		expect(evicted).toEqual(["session:alpha"]);
		expect(q.depth).toBe(1);
	});

	it("loads legacy items missing the version field, normalizes to 0", () => {
		// Pre-version-stamp daemons wrote queue items without
		// `version`. Strict reject would silently drop ALL pending
		// work on binary upgrade. The predicate now accepts missing
		// version and load() normalizes to 0 so downstream code
		// can rely on a number.
		const stateDir = process.env.CLAWDI_STATE_DIR ?? tmp;
		const path = join(stateDir, "claude_code", "queue.jsonl");
		mkdirSync(join(stateDir, "claude_code"), { recursive: true });
		const legacy = JSON.stringify({
			kind: "skill_push",
			skill_key: "legacy-key",
			new_hash: "h-legacy",
			scope_id: "s",
			enqueued_at: "2026-01-01T00:00:00Z",
			attempts: 0,
			// no version field
		});
		writeFileSync(path, `${legacy}\n`);

		const q = new RetryQueue({ agentType: "claude_code" });
		q.load();
		expect(q.depth).toBe(1);
		const item = q.peek();
		if (item?.kind !== "skill_push") throw new Error("expected skill_push");
		expect(item.version).toBe(0);
		expect(item.skill_key).toBe("legacy-key");
		// New enqueues bump from max(loaded.version)+1 = 1, so the
		// legacy-stamp doesn't collide with a fresh enqueue.
		const v = q.enqueue({
			kind: "skill_push",
			scope_id: "s",
			skill_key: "fresh-key",
			new_hash: "h-fresh",
			enqueued_at: "2026-01-02T00:00:00Z",
			attempts: 0,
		});
		expect(v).toBe(1);
	});
});
