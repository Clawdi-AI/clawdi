import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFirstConnection } from "./first-connection";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("only the first completed connection claims the dashboard hand-off", () => {
	const root = mkdtempSync(join(tmpdir(), "desktop-first-connection-"));
	roots.push(root);
	const marker = join(root, "first-connection");
	expect(claimFirstConnection(marker)).toBe(true);
	expect(claimFirstConnection(marker)).toBe(false);
	expect(claimFirstConnection(marker)).toBe(false);
});

test("an unwritable marker surfaces the error instead of opening repeatedly", () => {
	expect(() => claimFirstConnection(join(tmpdir(), "missing-dir-for-test", "marker"))).toThrow();
});
