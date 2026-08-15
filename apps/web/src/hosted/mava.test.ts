import { describe, expect, mock, test } from "bun:test";
import {
	buildMavaIdentity,
	createMavaIdentityController,
	type MavaIdentity,
	requestMavaWebChatToggle,
	startMavaIdentitySync,
	toggleMavaWebChat,
} from "@/hosted/mava";

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("buildMavaIdentity", () => {
	test("uses only direct Mava string fields and omits unavailable values", () => {
		expect(
			buildMavaIdentity({
				userId: " user_123 ",
				emailAddress: " ada@example.com ",
				fullName: " Ada Lovelace ",
			}),
		).toEqual({
			userId: "user_123",
			emailAddress: "ada@example.com",
			fullName: "Ada Lovelace",
		});
		expect(buildMavaIdentity({ userId: "user_123", emailAddress: " ", fullName: null })).toEqual({
			userId: "user_123",
		});
		expect(buildMavaIdentity({ userId: " ", emailAddress: null, fullName: null })).toBeNull();
	});
});

describe("Mava identity controller", () => {
	test("waits for the SDK, initializes before identify, and deduplicates the same identity", async () => {
		const calls: string[] = [];
		let sdk: unknown;
		const identity: MavaIdentity = {
			userId: "user_123",
			emailAddress: "ada@example.com",
			fullName: "Ada Lovelace",
		};
		const initialize = mock(() => {
			calls.push("initialize");
		});
		const identify = mock((receivedIdentity: MavaIdentity) => {
			calls.push("identify");
			expect(receivedIdentity).toEqual(identity);
		});
		const controller = createMavaIdentityController(() => sdk);

		expect(await controller.identify(identity)).toBe(false);
		sdk = { initialize, identify };
		expect(await controller.identify(identity)).toBe(true);
		expect(await controller.identify(identity)).toBe(true);

		expect(calls).toEqual(["initialize", "identify"]);
		expect(initialize).toHaveBeenCalledTimes(1);
		expect(identify).toHaveBeenCalledTimes(1);
	});

	test("contains SDK failures so a later readiness attempt can recover", async () => {
		const initialize = mock(() => {
			throw new Error("internal SDK failure");
		});
		const identify = mock(() => {});
		const controller = createMavaIdentityController(() => ({ initialize, identify }));
		const identity: MavaIdentity = { userId: "user_123" };

		expect(await controller.identify(identity)).toBe(false);
		expect(await controller.identify(identity)).toBe(false);
		expect(identify).not.toHaveBeenCalled();
	});
});

describe("startMavaIdentitySync", () => {
	test("responds to loader readiness and cleans up its listener and pending retry", async () => {
		let sdk: unknown;
		const readyListeners: Array<() => void> = [];
		let retryCancelled = false;
		const identify = mock(() => {});
		const controller = createMavaIdentityController(() => sdk);

		const stop = startMavaIdentitySync({
			controller,
			identity: { userId: "user_123" },
			subscribeReady: (listener) => {
				readyListeners.push(listener);
				return () => {
					const listenerIndex = readyListeners.indexOf(listener);
					if (listenerIndex >= 0) readyListeners.splice(listenerIndex, 1);
				};
			},
			scheduleRetry: () => () => {
				retryCancelled = true;
			},
		});
		await flushPromises();

		sdk = { initialize: () => {}, identify };
		readyListeners[0]?.();
		await flushPromises();

		expect(identify).toHaveBeenCalledTimes(1);
		expect(readyListeners).toHaveLength(0);
		expect(retryCancelled).toBe(true);
		stop();
	});

	test("bounds polling attempts when Mava remains unavailable", async () => {
		const retries: Array<() => void> = [];
		const controller = createMavaIdentityController(() => undefined);
		const stop = startMavaIdentitySync({
			controller,
			identity: { userId: "user_123" },
			retryLimit: 2,
			subscribeReady: () => () => {},
			scheduleRetry: (listener) => {
				retries.push(listener);
				return () => {};
			},
		});
		await flushPromises();

		expect(retries).toHaveLength(1);
		retries[0]?.();
		await flushPromises();
		expect(retries).toHaveLength(2);
		retries[1]?.();
		await flushPromises();
		expect(retries).toHaveLength(2);

		stop();
	});
});

describe("Mava live chat toggle", () => {
	test("validates the global toggle and contains widget failures", () => {
		const toggle = mock(() => {});

		expect(toggleMavaWebChat(() => undefined)).toBe(false);
		expect(toggleMavaWebChat(() => toggle)).toBe(true);
		expect(toggle).toHaveBeenCalledTimes(1);
		expect(
			toggleMavaWebChat(() => {
				throw new Error("widget unavailable");
			}),
		).toBe(false);
	});

	test("keeps delayed readiness beyond the caller lifecycle and replaces a stale request", () => {
		const readyListeners: Array<() => void> = [];
		let ready = false;
		let toggleCount = 0;
		let unsubscribeCount = 0;
		let retryCancellationCount = 0;
		const options = {
			toggle: () => {
				toggleCount += 1;
				return ready;
			},
			retryLimit: 1,
			subscribeReady: (listener: () => void) => {
				readyListeners.push(listener);
				return () => {
					unsubscribeCount += 1;
				};
			},
			scheduleRetry: () => () => {
				retryCancellationCount += 1;
			},
		};

		requestMavaWebChatToggle(options);
		requestMavaWebChatToggle(options);
		expect(unsubscribeCount).toBe(1);
		expect(retryCancellationCount).toBe(1);

		ready = true;
		readyListeners[1]?.();
		expect(toggleCount).toBe(3);
		expect(unsubscribeCount).toBe(2);
		expect(retryCancellationCount).toBe(2);
	});
});
