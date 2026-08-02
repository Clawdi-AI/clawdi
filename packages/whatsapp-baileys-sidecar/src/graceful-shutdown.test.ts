import { describe, expect, it } from "bun:test";

import { createSharedShutdown } from "./graceful-shutdown.js";

describe("shared graceful shutdown", () => {
	it("makes repeated signals await the same in-flight close", async () => {
		let release = (): void => {
			throw new Error("shutdown gate was not initialized");
		};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const signals: string[] = [];
		const shutdown = createSharedShutdown(async (signal: "SIGINT" | "SIGTERM") => {
			signals.push(signal);
			await gate;
		});

		const first = shutdown("SIGTERM");
		const second = shutdown("SIGINT");
		let settled = false;
		void second.then(() => {
			settled = true;
		});

		expect(second).toBe(first);
		await Promise.resolve();
		expect(signals).toEqual(["SIGTERM"]);
		expect(settled).toBe(false);

		release();
		await Promise.all([first, second]);
		expect(settled).toBe(true);
		expect(signals).toEqual(["SIGTERM"]);
	});

	it("shares a shutdown failure without rerunning the close", async () => {
		const failure = new Error("close failed");
		let calls = 0;
		const shutdown = createSharedShutdown(async () => {
			calls += 1;
			throw failure;
		});

		const first = shutdown();
		const second = shutdown();
		expect(second).toBe(first);
		await expect(first).rejects.toBe(failure);
		expect(calls).toBe(1);
	});
});
