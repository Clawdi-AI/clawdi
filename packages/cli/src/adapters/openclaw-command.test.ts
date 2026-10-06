import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenClawSdkExitError, runOpenClawSdkCommand } from "./openclaw-command";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sdkFixture(source: string): string {
	const root = mkdtempSync(".projection-rev7-sdk-");
	roots.push(root);
	const path = join(root, "sdk.mjs");
	writeFileSync(path, source);
	return path;
}

const params = { agentId: "main", sessionId: "fixture", sessionKey: "agent:main:main" };

describe("OpenClaw transcript SDK command", () => {
	test("reads entries on the dedicated pipe despite SDK stdout logging", async () => {
		const entries = [{ entryId: "fixture-user", message: { role: "user", content: "Prompt" } }];
		const path = sdkFixture(`
			console.log("[state/agent-db] agent database integrity gate");
			export function readVisibleSessionTranscriptMessageEntries(params) {
				if (params.sessionId !== "fixture") throw new Error("wrong SDK params");
				return ${JSON.stringify(entries)};
			}
		`);
		expect(
			JSON.parse(await runOpenClawSdkCommand(path, params, { timeout: 5000, maxBuffer: 4096 })),
		).toEqual(entries);
	});

	test("bounds result memory and keeps the subprocess slot usable after failure", async () => {
		const path = sdkFixture(
			'export const readVisibleSessionTranscriptMessageEntries = () => ["x".repeat(10000)];',
		);
		await expect(
			runOpenClawSdkCommand(path, params, { timeout: 5000, maxBuffer: 128 }),
		).rejects.toThrow("buffer limit");
		writeFileSync(path, "export const readVisibleSessionTranscriptMessageEntries = () => [];");
		expect(await runOpenClawSdkCommand(path, params, { timeout: 5000 })).toBe("[]");
	});

	test("drains transcript results larger than the pipe capacity", async () => {
		const path = sdkFixture(
			'export const readVisibleSessionTranscriptMessageEntries = () => [{ entryId: "large", message: { role: "user", content: "x".repeat(1024 * 1024) } }];',
		);
		const result = await runOpenClawSdkCommand(path, params, {
			timeout: 5000,
			maxBuffer: 2 * 1024 * 1024,
		});
		expect(JSON.parse(result)).toEqual([
			{ entryId: "large", message: { role: "user", content: "x".repeat(1024 * 1024) } },
		]);
	});

	test("reports the missing export exit code", async () => {
		const path = sdkFixture("export const unsupported = true;");
		await expect(runOpenClawSdkCommand(path, params, { timeout: 5000 })).rejects.toBeInstanceOf(
			OpenClawSdkExitError,
		);
	});

	test("cancels an SDK read and waits for its subprocess to close", async () => {
		const path = sdkFixture(
			"export const readVisibleSessionTranscriptMessageEntries = () => new Promise(() => { setInterval(() => {}, 1000); });",
		);
		const controller = new AbortController();
		const running = runOpenClawSdkCommand(path, params, {
			timeout: 5000,
			signal: controller.signal,
		});
		const timer = setTimeout(() => controller.abort(), 100);
		try {
			await expect(running).rejects.toThrow();
		} finally {
			clearTimeout(timer);
		}
	});
});
