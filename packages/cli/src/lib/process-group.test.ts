import { describe, expect, it } from "bun:test";
import { terminateProcessGroup } from "./process-group";

describe("terminateProcessGroup", () => {
	it("bounds both waits when process close is never observed", async () => {
		const signals: NodeJS.Signals[] = [];
		const child = {
			pid: undefined,
			kill(signal: NodeJS.Signals) {
				signals.push(signal);
				return true;
			},
		};
		const neverCloses = new Promise<void>(() => {});
		const started = Date.now();

		await terminateProcessGroup(child, neverCloses, {
			termTimeoutMs: 20,
			killTimeoutMs: 20,
		});

		expect(Date.now() - started).toBeLessThan(500);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
