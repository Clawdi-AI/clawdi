import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hermesWarmMarker, hermesWasWarmed } from "../src/runtime/hermes-warm-state";
import { getRuntimePaths } from "../src/runtime/paths";
import { warmHostedHermesRuntime } from "../src/runtime/runtime-warm-hermes";

let scratch = "";

afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = "";
});

test.each([
	"runtimeContextFile",
	"appliedState",
	"manifestLastGood",
	"managedSecretCacheFile",
] as const)("Hermes warm refuses %s before invoking services", async (marker) => {
	scratch = mkdtempSync(join(tmpdir(), "hermes-warm-safety-"));
	const paths = { ...getRuntimePaths({ mode: "hosted" }), [marker]: join(scratch, marker) };
	mkdirSync(dirname(paths[marker]), { recursive: true });
	writeFileSync(paths[marker], "{}");
	await expect(warmHostedHermesRuntime(paths)).rejects.toThrow("unclaimed runtime");
});

test("Hermes warm refuses local mode before invoking services", async () => {
	await expect(warmHostedHermesRuntime(getRuntimePaths({ mode: "local" }))).rejects.toThrow(
		"hosted runtime mode",
	);
});

test("Hermes warm marker rejects a writable file or symlink", () => {
	scratch = mkdtempSync(join(tmpdir(), "hermes-warm-marker-"));
	const paths = { ...getRuntimePaths({ mode: "hosted" }), runRoot: scratch };
	const marker = hermesWarmMarker(paths);
	expect(hermesWasWarmed(paths)).toBe(false);
	writeFileSync(marker, "warmed\n", { mode: 0o600 });
	expect(hermesWasWarmed(paths)).toBe(process.getuid?.() === 0);
	chmodSync(marker, 0o666);
	expect(hermesWasWarmed(paths)).toBe(false);
	rmSync(marker);
	const target = join(scratch, "target");
	writeFileSync(target, "warmed\n", { mode: 0o600 });
	symlinkSync(target, marker);
	expect(hermesWasWarmed(paths)).toBe(false);
});
