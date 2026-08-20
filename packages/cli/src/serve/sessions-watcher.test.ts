import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesAdapter } from "../adapters/hermes";
import {
	pollSessionPaths,
	SESSION_IDLE_POLL_INTERVAL_MS,
	SESSION_STABLE_AFTER_MS,
	type SessionWatchEvent,
	sessionPathSignature,
	sessionPathSnapshot,
	sleepForSessionPoll,
	watchSessions,
} from "./sessions-watcher";

describe("pollSessionPaths", () => {
	test("keeps the 60 second cadence while paths are idle", async () => {
		const abort = new AbortController();
		let now = 0;
		const delays: number[] = [];

		await pollSessionPaths(
			{
				paths: ["sessions"],
				abort: abort.signal,
				onPathStable: () => {
					throw new Error("idle paths must not emit stable events");
				},
			},
			{
				now: () => now,
				pathSignature: async () => "unchanged",
				sleep: async (delayMs) => {
					delays.push(delayMs);
					now += delayMs;
					if (delays.length === 2) abort.abort();
				},
			},
		);

		expect(delays).toEqual([SESSION_IDLE_POLL_INTERVAL_MS, SESSION_IDLE_POLL_INTERVAL_MS]);
	});

	test("checks at the quiescence deadline after detecting a change", async () => {
		const abort = new AbortController();
		let now = 0;
		const delays: number[] = [];
		const stableAt: number[] = [];

		await pollSessionPaths(
			{
				paths: ["sessions"],
				abort: abort.signal,
				onPathStable: () => {
					stableAt.push(now);
					abort.abort();
				},
			},
			{
				now: () => now,
				pathSignature: async () => (now < SESSION_IDLE_POLL_INTERVAL_MS ? "initial" : "changed"),
				sleep: async (delayMs) => {
					delays.push(delayMs);
					now += delayMs;
				},
			},
		);

		expect(delays).toEqual([SESSION_IDLE_POLL_INTERVAL_MS, SESSION_STABLE_AFTER_MS]);
		expect(stableAt).toEqual([SESSION_IDLE_POLL_INTERVAL_MS + SESSION_STABLE_AFTER_MS]);
	});

	test("reports concrete changed files from production-style poll snapshots", async () => {
		const abort = new AbortController();
		let now = 0;
		const sessionPath = "/sessions/changed.jsonl";
		const changes: SessionWatchEvent[] = [];

		await pollSessionPaths(
			{
				paths: ["/sessions"],
				abort: abort.signal,
				onPathStable: (change) => {
					changes.push(change);
					abort.abort();
				},
			},
			{
				now: () => now,
				pathSignature: async () => {
					throw new Error("pathSnapshot should provide the production poll state");
				},
				pathSnapshot: async () => ({
					signature: now === 0 ? "initial" : "changed",
					entries: new Map([[sessionPath, now === 0 ? "1:10" : "2:20"]]),
				}),
				sleep: async (delayMs) => {
					now += delayMs;
				},
			},
		);

		expect(changes).toEqual([{ kind: "paths", paths: [sessionPath] }]);
	});

	test("bounds tracked entries and requests a full scan when the cap is exceeded", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-session-snapshot-cap-"));
		const abort = new AbortController();
		let now = 0;
		let sleepCalls = 0;
		const changes: SessionWatchEvent[] = [];
		try {
			writeFileSync(join(root, "first.jsonl"), "first");
			writeFileSync(join(root, "second.jsonl"), "second");
			expect((await sessionPathSnapshot(root, 1)).entries).toBeNull();

			await pollSessionPaths(
				{
					paths: [root],
					abort: abort.signal,
					onPathStable: (change) => {
						changes.push(change);
						abort.abort();
					},
				},
				{
					now: () => now,
					pathSignature: async () => "unused",
					pathSnapshot: (path) => sessionPathSnapshot(path, 1),
					sleep: async (delayMs) => {
						now += delayMs;
						sleepCalls += 1;
						if (sleepCalls === 1) writeFileSync(join(root, "first.jsonl"), "changed");
					},
				},
			);

			expect(changes).toEqual([{ kind: "rescan" }]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("uses the injected monotonic clock rather than wall-clock time", async () => {
		const abort = new AbortController();
		let monotonicNow = 0;
		let wallNow = 1_000_000;
		const delays: number[] = [];
		const stableAt: number[] = [];
		const originalDateNow = Date.now;
		Date.now = () => wallNow;

		try {
			await pollSessionPaths(
				{
					paths: ["sessions"],
					abort: abort.signal,
					onPathStable: () => {
						stableAt.push(monotonicNow);
						abort.abort();
					},
				},
				{
					now: () => monotonicNow,
					pathSignature: async () =>
						monotonicNow < SESSION_IDLE_POLL_INTERVAL_MS ? "initial" : "changed",
					sleep: async (delayMs) => {
						delays.push(delayMs);
						monotonicNow += delayMs;
						wallNow += delays.length === 1 ? -900_000 : 3_600_000;
					},
				},
			);
		} finally {
			Date.now = originalDateNow;
		}

		expect(wallNow).toBeGreaterThan(1_000_000);
		expect(delays).toEqual([SESSION_IDLE_POLL_INTERVAL_MS, SESSION_STABLE_AFTER_MS]);
		expect(stableAt).toEqual([SESSION_IDLE_POLL_INTERVAL_MS + SESSION_STABLE_AFTER_MS]);
	});

	test("defers continuously changing paths and emits only once after they settle", async () => {
		const abort = new AbortController();
		let now = 0;
		const delays: number[] = [];
		const stableAt: number[] = [];

		await pollSessionPaths(
			{
				paths: ["sessions"],
				abort: abort.signal,
				onPathStable: () => {
					stableAt.push(now);
					abort.abort();
				},
			},
			{
				now: () => now,
				pathSignature: async () => {
					if (now < SESSION_IDLE_POLL_INTERVAL_MS) return "initial";
					if (now <= SESSION_IDLE_POLL_INTERVAL_MS + SESSION_STABLE_AFTER_MS * 3) {
						return `active-write-${now}`;
					}
					return "settled";
				},
				sleep: async (delayMs) => {
					delays.push(delayMs);
					now += delayMs;
				},
			},
		);

		expect(delays).toEqual([
			SESSION_IDLE_POLL_INTERVAL_MS,
			SESSION_STABLE_AFTER_MS,
			SESSION_STABLE_AFTER_MS,
			SESSION_STABLE_AFTER_MS,
			SESSION_STABLE_AFTER_MS,
			SESSION_STABLE_AFTER_MS,
		]);
		expect(stableAt).toEqual([SESSION_IDLE_POLL_INTERVAL_MS + SESSION_STABLE_AFTER_MS * 5]);
	});

	test("uses one quiescence deadline across all watched paths", async () => {
		const abort = new AbortController();
		let now = 0;
		const delays: number[] = [];
		const stableAt: number[] = [];

		await pollSessionPaths(
			{
				paths: ["first", "second"],
				abort: abort.signal,
				onPathStable: () => {
					stableAt.push(now);
					abort.abort();
				},
			},
			{
				now: () => now,
				pathSignature: async (path) => {
					if (path === "first") return now >= SESSION_IDLE_POLL_INTERVAL_MS ? "a1" : "a0";
					return now >= SESSION_IDLE_POLL_INTERVAL_MS + 10_000 ? "b1" : "b0";
				},
				sleep: async (delayMs) => {
					delays.push(delayMs);
					now += delayMs;
				},
			},
		);

		expect(delays).toEqual([
			SESSION_IDLE_POLL_INTERVAL_MS,
			SESSION_STABLE_AFTER_MS,
			SESSION_STABLE_AFTER_MS,
		]);
		expect(stableAt).toEqual([SESSION_IDLE_POLL_INTERVAL_MS + SESSION_STABLE_AFTER_MS * 2]);
	});

	test("stops after an abort that occurs during a signature read", async () => {
		const abort = new AbortController();
		let resolveSignature: ((value: string) => void) | undefined;
		let signatureCalls = 0;
		let stableCalls = 0;
		let markReadStarted: (() => void) | undefined;
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		const running = pollSessionPaths(
			{
				paths: ["sessions"],
				abort: abort.signal,
				onPathStable: () => {
					stableCalls += 1;
				},
			},
			{
				now: () => 0,
				pathSignature: async () => {
					signatureCalls += 1;
					if (signatureCalls === 1) return "initial";
					markReadStarted?.();
					return new Promise<string>((resolve) => {
						resolveSignature = resolve;
					});
				},
				sleep: async () => {},
			},
		);

		await readStarted;
		abort.abort();
		resolveSignature?.("changed");
		await running;

		expect(signatureCalls).toBe(2);
		expect(stableCalls).toBe(0);
	});

	test("aborts a pending scheduler wait without further signature or stable work", async () => {
		const abort = new AbortController();
		let signatureCalls = 0;
		let stableCalls = 0;
		let pendingWaits = 0;
		const scheduledDelays: number[] = [];
		let markWaitStarted: (() => void) | undefined;
		const waitStarted = new Promise<void>((resolve) => {
			markWaitStarted = resolve;
		});

		const running = pollSessionPaths(
			{
				paths: ["sessions"],
				abort: abort.signal,
				onPathStable: () => {
					stableCalls += 1;
				},
			},
			{
				now: () => 0,
				pathSignature: async () => {
					signatureCalls += 1;
					return "unchanged";
				},
				sleep: (delayMs, signal) =>
					sleepForSessionPoll(delayMs, signal, {
						schedule: (_callback, scheduledDelayMs) => {
							pendingWaits += 1;
							scheduledDelays.push(scheduledDelayMs);
							markWaitStarted?.();
							let pending = true;
							return () => {
								if (!pending) return;
								pending = false;
								pendingWaits -= 1;
							};
						},
					}),
			},
		);

		await waitStarted;
		expect(pendingWaits).toBe(1);
		abort.abort();
		await running;

		expect(pendingWaits).toBe(0);
		expect(scheduledDelays).toEqual([SESSION_IDLE_POLL_INTERVAL_MS]);
		expect(signatureCalls).toBe(1);
		expect(stableCalls).toBe(0);
	});
});

test("watchSessions returns immediately for a pre-aborted real fs watch", async () => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-session-pre-abort-"));
	const abort = new AbortController();
	abort.abort();
	let stableCalls = 0;
	try {
		await watchSessions({
			paths: [root],
			abort: abort.signal,
			onPathStable: () => {
				stableCalls += 1;
			},
		});
		expect(stableCalls).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 1_000);

test("debounces rapid fs events into one concrete changed-path batch", async () => {
	class InjectedWatcher extends EventEmitter {
		close(): void {}
	}

	const root = mkdtempSync(join(tmpdir(), "clawdi-session-path-batch-"));
	const abort = new AbortController();
	let onChange: (eventType?: string, filename?: string | Buffer | null) => void = () => {};
	let fireStable = () => {};
	const changes: SessionWatchEvent[] = [];
	try {
		const running = watchSessions(
			{
				paths: [root],
				abort: abort.signal,
				onPathStable: (change) => changes.push(change),
			},
			{
				createWatcher: (_path, _options, callback) => {
					onChange = callback;
					return new InjectedWatcher();
				},
				poll: async () => {},
				stableTimer: {
					schedule: (callback) => {
						fireStable = callback;
						return () => {};
					},
				},
			},
		);

		onChange("change", "first.jsonl");
		onChange("rename", Buffer.from("archived/second.jsonl"));
		onChange("change", "first.jsonl");
		fireStable();
		onChange("rename", null);
		fireStable();

		expect(changes).toEqual([
			{
				kind: "paths",
				paths: [join(root, "first.jsonl"), join(root, "archived/second.jsonl")],
			},
			{ kind: "rescan" },
		]);
		abort.abort();
		await running;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("falls back once when an attached fs watcher emits an asynchronous error", async () => {
	class InjectedWatcher extends EventEmitter {
		closeCalls = 0;

		close(): void {
			this.closeCalls += 1;
		}
	}

	const roots = [
		mkdtempSync(join(tmpdir(), "clawdi-session-async-watch-error-a-")),
		mkdtempSync(join(tmpdir(), "clawdi-session-async-watch-error-b-")),
	];
	const abort = new AbortController();
	const watchers: InjectedWatcher[] = [];
	let onChange: (eventType?: string, filename?: string | Buffer | null) => void = () => {};
	let scheduledStableCallback = () => {};
	let pendingStableTimers = 0;
	let stableCalls = 0;
	let pollCalls = 0;
	try {
		const running = watchSessions(
			{
				paths: roots,
				abort: abort.signal,
				onPathStable: () => {
					stableCalls += 1;
				},
			},
			{
				createWatcher: (_path, _options, callback) => {
					onChange = callback;
					const watcher = new InjectedWatcher();
					watchers.push(watcher);
					return watcher;
				},
				poll: async () => {
					pollCalls += 1;
				},
				stableTimer: {
					schedule: (callback) => {
						scheduledStableCallback = callback;
						pendingStableTimers += 1;
						let pending = true;
						return () => {
							if (!pending) return;
							pending = false;
							pendingStableTimers -= 1;
						};
					},
				},
			},
		);

		onChange();
		expect(watchers).toHaveLength(2);
		expect(pendingStableTimers).toBe(1);
		expect(watchers[0]?.emit("error", new Error("injected asynchronous watch failure"))).toBe(true);
		abort.abort();
		await running;

		expect(pollCalls).toBe(1);
		expect(watchers.map((watcher) => watcher.closeCalls)).toEqual([1, 1]);
		expect(pendingStableTimers).toBe(0);
		onChange();
		scheduledStableCallback();
		expect(stableCalls).toBe(0);
		expect(watchers[1]?.emit("error", new Error("late duplicate watch failure"))).toBe(true);
		expect(watchers.map((watcher) => watcher.closeCalls)).toEqual([1, 1]);
		expect(pollCalls).toBe(1);
	} finally {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	}
});

test("absorbs late watcher errors after a partial attach has switched to polling", async () => {
	class InjectedWatcher extends EventEmitter {
		closeCalls = 0;

		close(): void {
			this.closeCalls += 1;
		}
	}

	const root = mkdtempSync(join(tmpdir(), "clawdi-session-partial-watch-error-"));
	const watcher = new InjectedWatcher();
	const abort = new AbortController();
	let pollCalls = 0;
	try {
		await watchSessions(
			{
				paths: [root, join(root, "missing")],
				abort: abort.signal,
				onPathStable: () => {
					throw new Error("partial watcher must switch directly to polling");
				},
			},
			{
				createWatcher: () => watcher,
				poll: async () => {
					pollCalls += 1;
				},
				stableTimer: {
					schedule: () => {
						throw new Error("partial watcher must not schedule a stable callback");
					},
				},
			},
		);

		expect(pollCalls).toBe(1);
		expect(watcher.closeCalls).toBe(1);
		expect(watcher.emit("error", new Error("late partial-watch failure"))).toBe(true);
		expect(watcher.closeCalls).toBe(1);
		expect(pollCalls).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Hermes WAL commits change the production watch signature while state.db stays fixed", async () => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-hermes-wal-watch-"));
	const previousHermesHome = process.env.HERMES_HOME;
	process.env.HERMES_HOME = root;
	mkdirSync(root, { recursive: true });
	const databasePath = join(root, "state.db");
	const database = new Database(databasePath);
	try {
		database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
		database.exec("CREATE TABLE session_writes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
		database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		const adapter = new HermesAdapter();
		const paths = adapter.getSessionsWatchPaths();
		expect(paths).toEqual([databasePath, `${databasePath}-wal`, `${databasePath}-journal`]);
		const mainBefore = await sessionPathSignature(databasePath);
		const walBefore = await sessionPathSignature(`${databasePath}-wal`);
		const abort = new AbortController();
		let now = 0;
		const delays: number[] = [];
		let mainAfter = "";
		let walAfter = "";

		await pollSessionPaths(
			{
				paths,
				abort: abort.signal,
				onPathStable: () => abort.abort(),
			},
			{
				now: () => now,
				pathSignature: sessionPathSignature,
				sleep: async (delayMs) => {
					delays.push(delayMs);
					if (delays.length === 1) {
						database.exec("INSERT INTO session_writes (body) VALUES ('committed in wal')");
						mainAfter = await sessionPathSignature(databasePath);
						walAfter = await sessionPathSignature(`${databasePath}-wal`);
					}
					now += delayMs;
				},
			},
		);

		expect(mainAfter).toBe(mainBefore);
		expect(walAfter).not.toBe(walBefore);
		expect(delays).toEqual([SESSION_IDLE_POLL_INTERVAL_MS, SESSION_STABLE_AFTER_MS]);
	} finally {
		database.close();
		if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
		else process.env.HERMES_HOME = previousHermesHome;
		rmSync(root, { recursive: true, force: true });
	}
});
