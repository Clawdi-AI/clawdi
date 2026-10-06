import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { ApiClient, ApiError } from "./api-client";
import { readBoundedResponseBytes } from "./github-skill-archive";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("streaming archive requests", () => {
	it("stops a 25 MiB archive at the limit without downloading the remaining body", async () => {
		let produced = 0;
		let cancelled = false;
		globalThis.fetch = Object.assign(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							produced++;
							controller.enqueue(new Uint8Array(1024 * 1024));
							if (produced === 1000) controller.close();
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
			{ preconnect: originalFetch.preconnect },
		);
		const signal = AbortSignal.timeout(300_000);
		const response = await new ApiClient({ requireAuth: false }).requestStream("/archive", {
			signal,
		});
		await expect(
			readBoundedResponseBytes(response, 25 * 1024 * 1024, {
				signal,
				resourceLabel: "Project Skill archive",
				limitLabel: "25 MB",
				idleTimeoutMs: 30_000,
			}),
		).rejects.toThrow("25 MB download limit");
		expect(cancelled).toBe(true);
		expect(produced).toBeLessThanOrEqual(28);
	});

	it("allows a progressing download beyond 30 seconds and cleans up its idle timers", async () => {
		const originalTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
		let now = 0;
		function fakeTimeout(callback: TimerHandler, delay?: number, ...args: unknown[]): number;
		function fakeTimeout<TArgs extends unknown[]>(
			callback: (...args: TArgs) => void,
			delay?: number,
			...args: TArgs
		): ReturnType<typeof setTimeout>;
		function fakeTimeout(
			callback: TimerHandler,
			delay = 0,
			...args: unknown[]
		): number | ReturnType<typeof setTimeout> {
			if (typeof callback !== "function") throw new Error("unexpected string timer");
			const handle = originalTimeout(() => {}, 3_600_000);
			timers.set(handle, { at: now + delay, callback: () => callback(...args) });
			return handle;
		}
		const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(
			Object.assign(fakeTimeout, { __promisify__: originalTimeout.__promisify__ }),
		);
		const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
			for (const timer of timers.keys()) {
				if (timer === handle) {
					timers.delete(timer);
					originalClearTimeout(timer);
				}
			}
		});
		const advance = async (until: number) => {
			for (const [handle, timer] of [...timers].sort(([, a], [, b]) => a.at - b.at)) {
				if (timer.at > until) continue;
				clearTimeout(handle);
				now = timer.at;
				timer.callback();
			}
			now = until;
			for (let i = 0; i < 10; i++) await Promise.resolve();
		};
		try {
			let source: ReadableStreamDefaultController<Uint8Array> | undefined;
			globalThis.fetch = Object.assign(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								source = controller;
							},
						}),
					),
				{ preconnect: originalFetch.preconnect },
			);
			const total = new AbortController();
			const totalTimer = setTimeout(() => total.abort(), 300_000);
			const response = await new ApiClient({ requireAuth: false }).requestStream("/archive", {
				signal: total.signal,
			});
			const download = readBoundedResponseBytes(response, 100, {
				signal: total.signal,
				idleTimeoutMs: 30_000,
			});
			for (const at of [20_000, 40_000, 60_000]) {
				await advance(at);
				source?.enqueue(new Uint8Array([1]));
				await advance(at);
			}
			source?.close();
			expect(await download).toEqual(Buffer.from([1, 1, 1]));
			clearTimeout(totalTimer);
			expect(timers.size).toBe(0);
		} finally {
			for (const handle of timers.keys()) originalClearTimeout(handle);
			timerSpy.mockRestore();
			clearSpy.mockRestore();
		}
	});

	it("retries connection failures and reports a network error", async () => {
		let attempts = 0;
		globalThis.fetch = Object.assign(
			async () => {
				attempts++;
				throw new TypeError("connect failed");
			},
			{ preconnect: originalFetch.preconnect },
		);
		await expect(
			new ApiClient({ requireAuth: false }).requestStream("/archive"),
		).rejects.toBeInstanceOf(ApiError);
		expect(attempts).toBe(3);
	});

	it("caller cancellation remains effective after response headers", async () => {
		let cancelled = false;
		globalThis.fetch = Object.assign(
			async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
			{ preconnect: originalFetch.preconnect },
		);
		const abort = new AbortController();
		const response = await new ApiClient({ requireAuth: false }).requestStream("/archive", {
			signal: abort.signal,
		});
		const download = readBoundedResponseBytes(response, 100, { signal: abort.signal });
		abort.abort();
		await expect(download).rejects.toThrow();
		expect(cancelled).toBe(true);
	});
});
