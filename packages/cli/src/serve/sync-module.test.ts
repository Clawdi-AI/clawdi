import { expect, test } from "bun:test";
import { SyncModule } from "./sync-module";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("replacement waits for both a captured upload lease and failed worker cleanup", async () => {
	const abort = new AbortController();
	const ready = deferred();
	const draining = deferred();
	const failed = deferred();
	const cleanup = deferred();
	let attempts = 0;
	const slot = new SyncModule({
		signal: abort.signal,
		changed: (state) => {
			if (state === "ready") ready.resolve();
			if (state === "draining") draining.resolve();
		},
		failed: () => {},
		prepare: async (scope) => {
			attempts++;
			scope.track(cleanup.promise);
			return {
				run: async () => {
					await failed.promise;
					throw new Error("watcher failed");
				},
			};
		},
	});
	const running = slot.run();
	let release = () => {};
	try {
		await ready.promise;
		const lease = slot.acquire();
		release = lease?.release ?? release;
		expect(lease).not.toBeNull();
		failed.resolve();
		await draining.promise;
		expect(slot.acquire()).toBeNull();
		expect(lease?.signal.aborted).toBe(true);
		cleanup.resolve();
		await Promise.resolve();
		expect(attempts).toBe(1);
		expect(slot.state).toBe("draining");
		abort.abort();
		lease?.release();
		await running;
		expect(slot.state).toBe("stopped");
	} finally {
		abort.abort();
		release();
		failed.resolve();
		cleanup.resolve();
		await running;
	}
});
