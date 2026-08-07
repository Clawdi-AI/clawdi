import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPrivateDirectoryLock } from "./private-directory-lock";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lockFixture(): { lockDir: string; ownerPath: string } {
	const root = mkdtempSync(join(tmpdir(), "clawdi-private-lock-"));
	roots.push(root);
	const lockDir = join(root, "credentials.lock");
	return { lockDir, ownerPath: join(lockDir, "owner.json") };
}

function writeOwner(
	lockDir: string,
	owner: { pid: number; acquiredAt: string; token: string },
): void {
	mkdirSync(lockDir, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(lockDir, "owner.json"),
		`${JSON.stringify({ schemaVersion: "clawdi.privateDirectoryLockOwner.v1", ...owner })}\n`,
		{ mode: 0o600 },
	);
}

describe("private directory lock", () => {
	test("serializes contenders and keeps lock metadata owner-only", async () => {
		const { lockDir, ownerPath } = lockFixture();
		const events: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = withPrivateDirectoryLock(lockDir, async (lease) => {
			events.push("first:start");
			expect(statSync(lockDir).mode & 0o777).toBe(0o700);
			expect(statSync(ownerPath).mode & 0o777).toBe(0o600);
			lease.assertOwned();
			await gate;
			events.push("first:end");
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = withPrivateDirectoryLock(lockDir, async () => {
			events.push("second");
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(events).toEqual(["first:start"]);
		releaseFirst?.();
		await Promise.all([first, second]);
		expect(events).toEqual(["first:start", "first:end", "second"]);
	});

	test("reclaims a dead owner but never reclaims an old live owner", async () => {
		const dead = lockFixture();
		writeOwner(dead.lockDir, {
			pid: 99_999_999,
			acquiredAt: "2000-01-01T00:00:00.000Z",
			token: "dead-owner",
		});
		await withPrivateDirectoryLock(dead.lockDir, async () => undefined, {
			timeoutMs: 20,
			retryMs: 1,
			isProcessAlive: () => false,
		});
		expect(existsSync(dead.lockDir)).toBe(false);

		const live = lockFixture();
		writeOwner(live.lockDir, {
			pid: process.pid,
			acquiredAt: "2000-01-01T00:00:00.000Z",
			token: "live-owner",
		});
		await expect(
			withPrivateDirectoryLock(live.lockDir, async () => undefined, {
				timeoutMs: 10,
				staleMs: 1,
				retryMs: 1,
				isProcessAlive: () => true,
			}),
		).rejects.toThrow("timed out waiting for private lock");
		expect(JSON.parse(readFileSync(live.ownerPath, "utf8")).token).toBe("live-owner");
	});

	test("reclaims ownerless metadata only after its mtime is stale", async () => {
		const { lockDir } = lockFixture();
		mkdirSync(lockDir, { mode: 0o700 });
		const old = new Date(Date.now() - 10_000);
		utimesSync(lockDir, old, old);
		let entered = false;
		await withPrivateDirectoryLock(
			lockDir,
			async () => {
				entered = true;
			},
			{ staleMs: 100, timeoutMs: 20, retryMs: 1 },
		);
		expect(entered).toBe(true);
	});

	test("fences an ABA replacement between stale observation and rename", async () => {
		const { lockDir, ownerPath } = lockFixture();
		writeOwner(lockDir, {
			pid: 99_999_999,
			acquiredAt: "2000-01-01T00:00:00.000Z",
			token: "stale-owner",
		});
		let entered = false;
		let hookCalls = 0;
		await expect(
			withPrivateDirectoryLock(
				lockDir,
				async () => {
					entered = true;
				},
				{
					timeoutMs: 10,
					retryMs: 1,
					isProcessAlive: (pid) => pid === process.pid,
					beforeReclaimRename: () => {
						hookCalls += 1;
						rmSync(lockDir, { recursive: true, force: true });
						writeOwner(lockDir, {
							pid: process.pid,
							acquiredAt: new Date().toISOString(),
							token: "successor-owner",
						});
					},
				},
			),
		).rejects.toThrow("timed out waiting for private lock");
		expect(entered).toBe(false);
		expect(hookCalls).toBe(1);
		expect(JSON.parse(readFileSync(ownerPath, "utf8")).token).toBe("successor-owner");
	});

	test("release verifies the owner token and never deletes a takeover", async () => {
		const { lockDir, ownerPath } = lockFixture();
		await withPrivateDirectoryLock(lockDir, async () => {
			const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
			writeFileSync(ownerPath, `${JSON.stringify({ ...owner, token: "takeover" })}\n`, {
				mode: 0o600,
			});
		});
		expect(existsSync(lockDir)).toBe(true);
		expect(JSON.parse(readFileSync(ownerPath, "utf8")).token).toBe("takeover");
	});

	test("two stale reclaimers still enter the critical section one at a time", async () => {
		const { lockDir } = lockFixture();
		writeOwner(lockDir, {
			pid: 99_999_999,
			acquiredAt: "2000-01-01T00:00:00.000Z",
			token: "stale-owner",
		});
		const events: string[] = [];
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = withPrivateDirectoryLock(lockDir, async (lease) => {
			events.push("first:start");
			await gate;
			lease.assertOwned();
			events.push("first:end");
		});
		const second = withPrivateDirectoryLock(lockDir, async (lease) => {
			lease.assertOwned();
			events.push("second");
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(events).toEqual(["first:start"]);
		release?.();
		await Promise.all([first, second]);
		expect(events).toEqual(["first:start", "first:end", "second"]);
	});
});
