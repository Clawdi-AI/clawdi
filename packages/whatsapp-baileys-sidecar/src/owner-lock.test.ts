import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireProviderAccountOwnerLock } from "./owner-lock.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provider account owner lock", () => {
	test("allows exactly one physical socket owner for an account session", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-provider-owner-"));
		roots.push(sessionDir);

		const first = acquireProviderAccountOwnerLock(sessionDir, "account-a");
		expect(JSON.parse(readFileSync(first.path, "utf-8"))).toMatchObject({
			accountId: "account-a",
			pid: process.pid,
		});
		expect(() => acquireProviderAccountOwnerLock(sessionDir, "account-a")).toThrow(
			"exclusively owned",
		);

		first.release();
		const replacement = acquireProviderAccountOwnerLock(sessionDir, "account-a");
		replacement.release();
	});

	test("does not let a different account reuse the same durable auth state", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-provider-owner-"));
		roots.push(sessionDir);

		const first = acquireProviderAccountOwnerLock(sessionDir, "account-a");
		expect(() => acquireProviderAccountOwnerLock(sessionDir, "account-b")).toThrow(
			"account account-a",
		);
		first.release();
	});
});
