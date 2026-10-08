import { afterEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncReadContext } from "./base";
import {
	addSessionModel,
	describeSessionContent,
	JsonlSessionSource,
	jsonlStatRevision,
	RACY_CLEAN_WINDOW_NS,
	readBoundedJsonFile,
	SESSION_RECORD_MAX_BYTES,
} from "./session-source";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(content: string): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-source-test-"));
	roots.push(root);
	const path = join(root, "session.jsonl");
	writeFileSync(path, content);
	return path;
}

async function records(source: JsonlSessionSource) {
	const result = [];
	for await (const value of source.records()) result.push(value);
	return result;
}

describe("bounded session sources", () => {
	test("preserves UTF-8 across buffers, physical sequence and indexed offsets", async () => {
		const text = `${"x".repeat(65520)}\u4e2d\u6587${"y".repeat(50)}`;
		const source = await JsonlSessionSource.open(
			fixture(`\n${JSON.stringify({ text })}\r\ninvalid\n{"last":true}`),
		);
		const values = await records(source);
		expect(values.map((value) => value.recordSeq)).toEqual([1, 3]);
		expect(values[0]?.data.text).toBe(text);
		expect(source.complete).toBe(false);
		for (const value of values)
			expect(await source.readRecord(value.offset, value.length)).toEqual(value.data);
		expect(await records(source)).toEqual(values);
	});

	test("ignores a partial trailing row and retains the last complete object", async () => {
		const source = await JsonlSessionSource.open(fixture('{"ok":1}\n{"unfinished":'));
		expect((await records(source)).map((value) => value.data)).toEqual([{ ok: 1 }]);
		expect(source.complete).toBe(false);
	});

	test("pins the initial file prefix when the agent appends during or after reading", async () => {
		const path = fixture('{"n":1}\n{"n":2}\n');
		const source = await JsonlSessionSource.open(path);
		const received = [];
		for await (const value of source.records()) {
			received.push(value.data);
			if (received.length === 1) appendFileSync(path, '{"n":3}\n');
		}
		expect(received).toEqual([{ n: 1 }, { n: 2 }]);
		expect((await records(source)).map((value) => value.data)).toEqual(received);
		expect((await records(await JsonlSessionSource.open(path))).length).toBe(3);
	});

	test("rejects same-length rewrites, truncation and pathname replacement", async () => {
		for (const change of ["rewrite", "truncate", "replace"]) {
			const path = fixture('{"n":1}\n');
			const source = await JsonlSessionSource.open(path);
			await records(source);
			if (change === "replace") renameSync(path, `${path}.old`);
			writeFileSync(path, change === "truncate" ? "" : '{"n":2}\n');
			await expect(records(source)).rejects.toThrow(/rewritten|replaced|truncated/);
		}
	});

	test("blocks a source file when a record exceeds its limit before parsing", async () => {
		const source = await JsonlSessionSource.open(
			fixture(`{"text":"${"x".repeat(SESSION_RECORD_MAX_BYTES)}"}`),
		);
		expect(await records(source)).toEqual([]);
		expect(source.blockedReason).toContain("source record exceeds");
	});

	test("cancels mid-buffer and releases the source handle", async () => {
		const controller = new AbortController();
		const context: SyncReadContext = { signal: controller.signal, streaming: true };
		const source = await JsonlSessionSource.open(fixture('{"n":1}\n{"n":2}\n'), context);
		const iterator = source.records();
		expect((await iterator.next()).value?.data).toEqual({ n: 1 });
		controller.abort(new Error("cancel fixture"));
		await expect(iterator.next()).rejects.toThrow("cancel fixture");
	});

	test("limits JSON inventory before allocating its contents", async () => {
		const path = fixture('{"entries":[1,2]}');
		expect(await readBoundedJsonFile(path)).toEqual({ entries: [1, 2] });
		await expect(readBoundedJsonFile(path, undefined, 4)).rejects.toThrow("metadata size");
	});

	test("describes large history lazily without losing count, title or last timestamp", async () => {
		const readEvents = async function* () {
			for (let seq = 0; seq < 1000; seq++)
				yield {
					seq,
					type: "message" as const,
					role: "user" as const,
					event_id: `fixture-${seq}`,
					source: { adapter: "pi" as const, session_key: "fixture", record_id: `${seq}` },
					parts: [{ type: "text" as const, text: `${seq}:${"x".repeat(1024)}` }],
					timestamp: new Date(1776247000000 + seq).toISOString(),
				};
		};
		const summary = await describeSessionContent(readEvents, true);
		expect(summary.messageCount).toBe(1000);
		expect(summary.content.events).toBeUndefined();
		expect(summary.content.messages).toEqual([]);
		expect(summary.content.readEvents).toBe(readEvents);
		expect(summary.firstUser?.content.startsWith("0:")).toBe(true);
		expect(summary.lastTimestamp).toBe(new Date(1776247000999).toISOString());
	});

	test("bounds unique model metadata while allowing repeated model use", () => {
		const models = new Set<string>();
		for (let index = 0; index < 128; index++) addSessionModel(models, `model-${index}`);
		addSessionModel(models, "model-0");
		expect(() => addSessionModel(models, "new-model")).toThrow("metadata exceeds");
		expect(() => addSessionModel(new Set(), "x".repeat(8193))).toThrow("metadata exceeds");
	});
});

describe("JSONL stat revisions", () => {
	test("requires a completed read and a non-racy mtime, but allows a recent ctime", async () => {
		const path = fixture('{"n":1}\n');
		const past = new Date(Date.now() - 10_000);
		utimesSync(path, past, past);
		const source = await JsonlSessionSource.open(path);
		expect(source.revision).toBeUndefined();
		await records(source);
		expect(source.revision).toBe(jsonlStatRevision(statSync(path, { bigint: true })));
		const stat = statSync(path, { bigint: true });
		const now = BigInt(Date.now()) * 1_000_000n;
		const supported = Object.assign(stat, {
			ino: 1n,
			ctimeNs: now,
			mtimeNs: now - RACY_CLEAN_WINDOW_NS,
		});
		expect(jsonlStatRevision(supported, now)).toStartWith("jsonl-stat-v1:");
		const recent = Object.assign(stat, { mtimeNs: now - RACY_CLEAN_WINDOW_NS + 1n });
		expect(jsonlStatRevision(recent, now)).toBeUndefined();
		expect(jsonlStatRevision(Object.assign(stat, { mtimeNs: now + 1n }), now)).toBeUndefined();
	});

	test("falls back to parsing when a platform lacks a usable identity or timestamp", () => {
		const path = fixture('{"n":1}\n');
		const past = new Date(Date.now() - 10_000);
		utimesSync(path, past, past);
		for (const unavailable of [
			{ ino: 0n },
			{ ino: undefined },
			{ ctimeNs: 0n },
			{ ctimeNs: undefined },
			{ mtimeNs: undefined },
			{ size: undefined },
		]) {
			const stat = Object.assign(statSync(path, { bigint: true }), unavailable);
			expect(jsonlStatRevision(stat)).toBeUndefined();
		}
	});
});
