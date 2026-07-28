import { describe, expect, test } from "bun:test";
import {
	pollSessionPaths,
	SESSION_IDLE_POLL_INTERVAL_MS,
	SESSION_STABLE_AFTER_MS,
	sleepForSessionPoll,
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
