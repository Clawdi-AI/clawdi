import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRuntimeConvergeLockAsync } from "./manifest";
import { getRuntimePaths } from "./paths";

const originalEnv = { ...process.env };
const roots: string[] = [];

afterEach(() => {
	process.env = { ...originalEnv };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime async converge lock", () => {
	test("serializes fetch-through-commit work so a stale writer cannot overtake", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-converge-lock-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const paths = getRuntimePaths({ mode: "hosted" });
		const events: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = withRuntimeConvergeLockAsync(paths, async () => {
			events.push("A:fetch");
			await firstGate;
			events.push("A:commit");
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		const second = withRuntimeConvergeLockAsync(paths, async () => {
			events.push("B:fetch");
			events.push("B:commit");
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(events).toEqual(["A:fetch"]);
		releaseFirst?.();
		await Promise.all([first, second]);
		expect(events).toEqual(["A:fetch", "A:commit", "B:fetch", "B:commit"]);
	});
});
