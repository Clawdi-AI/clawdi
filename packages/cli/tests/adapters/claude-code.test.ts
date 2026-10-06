import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code";
import { assertSessionGolden } from "../../src/adapters/session-golden.test-support";
import { prepareSessionUpload } from "../../src/lib/session-upload";
import { tarSkillDir } from "../../src/lib/tar";
import {
	managedSkillReservationState,
	releaseManagedSkill,
	reserveManagedSkill,
} from "../../src/runtime/managed-skill-reservation";
import { cleanupTmp, copyFixtureToTmp } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origConfigDir: string | undefined;
let origPath: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origConfigDir = process.env.CLAUDE_CONFIG_DIR;
	origPath = process.env.PATH;
	delete process.env.CLAUDE_CONFIG_DIR;
	tmpHome = copyFixtureToTmp("claude_code");
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origConfigDir) process.env.CLAUDE_CONFIG_DIR = origConfigDir;
	else delete process.env.CLAUDE_CONFIG_DIR;
	if (origPath !== undefined) process.env.PATH = origPath;
	cleanupTmp(tmpHome);
});

describe("ClaudeCodeAdapter.detect", () => {
	it("returns true when $HOME/.claude exists", async () => {
		const a = new ClaudeCodeAdapter();
		expect(await a.detect()).toBe(true);
	});

	it("returns false when $HOME/.claude is absent and `claude` binary is unreachable", async () => {
		process.env.HOME = `/tmp/clawdi-nowhere-${Date.now()}`;
		const a = new ClaudeCodeAdapter();
		// Stub the binary-fallback to fail (CI/dev machines often have `claude`
		// in PATH; `process.env.PATH = ""` doesn't reliably hide it because
		// child_process inherits a cached env on some platforms).
		(a as { getVersion: () => Promise<string | null> }).getVersion = async () => null;
		expect(await a.detect()).toBe(false);
	});

	it("falls back to `claude --version` when the home dir has no artifacts", async () => {
		// Bare `~/.claude/` with no artifacts shouldn't false-positive — but a
		// reachable `claude` binary still indicates a real install.
		const bareHome = `${tmpHome}-bare`;
		const { mkdirSync, rmSync } = await import("node:fs");
		mkdirSync(join(bareHome, ".claude"), { recursive: true });
		process.env.HOME = bareHome;

		const a = new ClaudeCodeAdapter();
		(a as { getVersion: () => Promise<string | null> }).getVersion = async () => null;
		expect(await a.detect()).toBe(false);
		(a as { getVersion: () => Promise<string | null> }).getVersion = async () => "claude 0.1.0";
		expect(await a.detect()).toBe(true);
		rmSync(bareHome, { recursive: true, force: true });
	});

	it("honors $CLAUDE_CONFIG_DIR override", async () => {
		process.env.HOME = `/tmp/clawdi-nowhere-${Date.now()}`;
		process.env.CLAUDE_CONFIG_DIR = join(tmpHome, ".claude");
		const a = new ClaudeCodeAdapter();
		expect(await a.detect()).toBe(true);
	});
});

describe("ClaudeCodeAdapter.collectSessions", () => {
	it("hides meta injections and excludes compact summaries from the title", async () => {
		const file = join(
			tmpHome,
			".claude",
			"projects",
			"-Users-fixture-project",
			"meta-summary.jsonl",
		);
		cpSync(resolve(import.meta.dir, "../fixtures/claude-meta-summary.jsonl"), file);
		for (const streaming of [false, true]) {
			const session = await new ClaudeCodeAdapter().sessions.resolve("meta-summary", {
				streaming,
				signal: new AbortController().signal,
			});
			if (!session) throw new Error("expected Claude meta summary fixture");
			expect(session.summary).toBe("Actual user prompt");
			expect(session.messageCount).toBe(3);
			const upload = await prepareSessionUpload(session, "events-v1");
			const events = [];
			for await (const event of upload.readEvents?.() ?? upload.events ?? []) events.push(event);
			expect(
				events
					.filter((event) => event.semantics?.display === "hidden")
					.map((event) => event.source.record_id),
			).toEqual(["skill-injection", "command-caveat"]);
			expect(
				events.find((event) => event.source.record_id === "compact-summary")?.semantics,
			).toEqual({ lifecycle: "active", display: "event", compressed_summary: true });
			expect(events.filter((event) => event.semantics?.display_kind === "meta")).toHaveLength(2);
		}
		const session = await new ClaudeCodeAdapter().sessions.resolve("meta-summary");
		expect(session?.messages.map((message) => message.content)).toEqual([
			"Compressed conversation summary",
			"Actual user prompt",
			"Actual assistant answer",
		]);
	});

	it("does not invent a first prompt from meta or compact-only records", async () => {
		const file = join(
			tmpHome,
			".claude",
			"projects",
			"-Users-fixture-project",
			"compact-only.jsonl",
		);
		writeFileSync(
			file,
			`${readFileSync(resolve(import.meta.dir, "../fixtures/claude-meta-summary.jsonl"), "utf8")
				.split("\n")
				.slice(0, 3)
				.join("\n")}\n`,
		);
		const session = await new ClaudeCodeAdapter().sessions.resolve("compact-only");
		expect(session?.summary).toBeNull();
		expect(session?.messageCount).toBe(1);
	});
	it("ignores invalid metadata timestamps without changing uploaded content", async () => {
		const adapter = new ClaudeCodeAdapter();
		const original = (await adapter.sessions.collect({ kind: "complete" })).sessions[0];
		if (!original) throw new Error("expected Claude fixture session");
		writeFileSync(
			original.rawFilePath,
			`${readFileSync(original.rawFilePath, "utf8").replace(
				"2026-04-20T10:00:00.000Z",
				"not-a-timestamp",
			)}${JSON.stringify({ type: "session-metadata", timestamp: "not-a-timestamp" })}\n`,
		);
		const current = (await adapter.sessions.collect({ kind: "complete" })).sessions[0];
		if (!current) throw new Error("expected Claude fixture session with valid message timestamps");
		expect(current.startedAt.toISOString()).toBe("2026-04-20T10:00:01.000Z");
		expect(current.endedAt?.toISOString()).toBe("2026-04-20T10:00:05.000Z");
		expect(current.events).toEqual(original.events);
		expect((await prepareSessionUpload(current, "events-v1")).localHash).toBe(
			(await prepareSessionUpload(original, "events-v1")).localHash,
		);
	});

	it("bounds models in metadata records that emit no events", async () => {
		const adapter = new ClaudeCodeAdapter();
		const session = (await adapter.sessions.collect({ kind: "complete" })).sessions[0];
		if (!session) throw new Error("expected Claude fixture session");
		const records = Array.from({ length: 128 }, (_, index) =>
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", model: `model-${index}`, content: [] },
			}),
		);
		writeFileSync(
			session.rawFilePath,
			`${readFileSync(session.rawFilePath, "utf8")}${records.join("\n")}\n`,
		);
		await expect(adapter.sessions.collect({ kind: "complete" })).rejects.toThrow(
			"session model metadata exceeds supported bounds",
		);
	});

	it("keeps a two-record prompt and answer transcript", async () => {
		const file = join(tmpHome, ".claude", "projects", "-Users-fixture-project", "two-record.jsonl");
		writeFileSync(
			file,
			[
				{
					uuid: "short-user",
					timestamp: "2026-10-06T01:00:00.000Z",
					message: { role: "user", content: "Short prompt" },
				},
				{
					uuid: "short-assistant",
					timestamp: "2026-10-06T01:00:01.000Z",
					message: { role: "assistant", content: "Short answer" },
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n") + "\n",
		);
		const session = await new ClaudeCodeAdapter().sessions.resolve("two-record");
		expect(session?.messageCount).toBe(2);
		expect(session?.messages.map((message) => message.content)).toEqual([
			"Short prompt",
			"Short answer",
		]);
	});

	it("describes the first projected user message for the summary", async () => {
		const file = join(tmpHome, ".claude", "projects", "-Users-fixture-project", "summary.jsonl");
		writeFileSync(
			file,
			[
				{
					uuid: "summary-user",
					timestamp: "2026-10-06T01:00:00.000Z",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "First paragraph" },
							{ type: "text", text: "Second paragraph" },
						],
					},
				},
				{
					uuid: "summary-assistant",
					timestamp: "2026-10-06T01:00:01.000Z",
					message: { role: "assistant", content: "Answer" },
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n") + "\n",
		);
		const session = await new ClaudeCodeAdapter().sessions.resolve("summary");
		expect(session?.summary).toBe("First paragraph\nSecond paragraph");
		expect(session?.summary).toBe(session?.messages[0]?.content);
	});

	it("counts shared multi-block message usage once and still counts records without an id", async () => {
		const file = join(
			tmpHome,
			".claude",
			"projects",
			"-Users-fixture-project",
			"usage-dedup.jsonl",
		);
		cpSync(resolve(import.meta.dir, "../fixtures/claude-usage-dedup.jsonl"), file);
		const session = await new ClaudeCodeAdapter().sessions.resolve("usage-dedup");
		expect(session).toMatchObject({ inputTokens: 9, outputTokens: 16, cacheReadTokens: 4 });
		expect(
			session?.events?.filter((event) => event.source.record_id.startsWith("block-")),
		).toHaveLength(3);
	});

	it("preserves origin/main session bytes and localHash", async () => {
		await assertSessionGolden("claude-code", new ClaudeCodeAdapter().sessions);
	});
	it("parses the fixture session with correct tokens and model", async () => {
		const a = new ClaudeCodeAdapter();
		const { sessions, dedupedCount } = await a.sessions.collect({ kind: "complete" });
		expect(sessions).toHaveLength(1);
		expect(dedupedCount).toBe(0);
		const s = sessions[0]!;
		expect(s).toMatchObject({
			localSessionId: "11111111-2222-3333-4444-555555555555",
			projectPath: "/Users/fixture/project",
			model: "claude-opus-4-7",
			messageCount: 4, // 2 user + 2 assistant with non-empty text
			inputTokens: 30, // 10 + 20
			outputTokens: 8, // 5 + 3
			cacheReadTokens: 7, // 2 + 5
		});
		expect(s.modelsUsed).toEqual(["claude-opus-4-7"]);
		expect(s.startedAt.toISOString()).toBe("2026-04-20T10:00:00.000Z");
		expect(s.endedAt?.toISOString()).toBe("2026-04-20T10:00:05.000Z");
		expect(s.durationSeconds).toBe(5);
	});

	it("extracts text from array content blocks (type:text)", async () => {
		const a = new ClaudeCodeAdapter();
		const { sessions } = await a.sessions.collect({ kind: "complete" });
		const texts = sessions[0]?.messages.map((m) => m.content);
		expect(texts).toEqual(["hello", "world", "one more", "done"]);
	});

	it("uploads thinking and redacted continuation without adding it to messages", async () => {
		const sessionPath = join(
			tmpHome,
			".claude",
			"projects",
			"-Users-fixture-project",
			"11111111-2222-3333-4444-555555555555.jsonl",
		);
		const record = {
			type: "assistant",
			uuid: "reasoning-record",
			timestamp: "2026-04-20T10:00:06.000Z",
			message: {
				role: "assistant",
				model: "claude-opus-4-7",
				content: [
					{ type: "thinking", thinking: "private Claude thought", signature: "signed" },
					{ type: "redacted_thinking", data: "opaque-redacted" },
					{ type: "text", text: "visible answer after thinking" },
				],
			},
		};
		writeFileSync(
			sessionPath,
			`${readFileSync(sessionPath, "utf-8").trimEnd()}\n${JSON.stringify(record)}\n`,
		);

		const session = (await new ClaudeCodeAdapter().sessions.collect({ kind: "complete" }))
			.sessions[0];
		const reasoning = session?.events?.filter((event) => event.type === "reasoning") ?? [];
		expect(reasoning).toMatchObject([
			{
				kind: "thinking",
				parts: [{ type: "text", text: "private Claude thought" }],
				payload_json: '{"signature":"signed"}',
			},
			{
				kind: "redacted",
				parts: [],
				payload_json: '{"redacted_data":"opaque-redacted"}',
			},
		]);
		expect(session?.messages.at(-1)?.content).toBe("visible answer after thinking");
		expect(JSON.stringify(session?.messages)).not.toContain("private Claude thought");
	});

	it("filters by projectFilter (matching cwd → encoded dir)", async () => {
		const a = new ClaudeCodeAdapter();
		const matched = await a.sessions.collect({
			kind: "complete",
			projectFilter: "/Users/fixture/project",
		});
		expect(matched.sessions).toHaveLength(1);
		const notMatched = await a.sessions.collect({
			kind: "complete",
			projectFilter: "/Users/other/project",
		});
		expect(notMatched.sessions).toHaveLength(0);
	});

	it("skips transcripts without projected messages", async () => {
		const shortPath = join(tmpHome, ".claude", "projects", "-Users-fixture-project", "short.jsonl");
		writeFileSync(shortPath, `${JSON.stringify({ timestamp: "2026-04-20T10:00:00Z" })}\n`);
		const a = new ClaudeCodeAdapter();
		const { sessions } = await a.sessions.collect({ kind: "complete" });
		// The original session counts; a metadata-only file has no projected messages.
		expect(sessions).toHaveLength(1);
	});

	it("first user message populates the summary (capped at 200 chars)", async () => {
		const a = new ClaudeCodeAdapter();
		const s = (await a.sessions.collect({ kind: "complete" })).sessions[0]!;
		expect(s.summary).toBe("hello");
	});

	it("limits concrete path collection to the affected project", async () => {
		writeResumeSessionFile({
			cwd: "/Users/fixture/other-project",
			sessionId: "other-project-session",
			uuids: uuidRange("other", 4),
		});
		const changedPath = join(
			tmpHome,
			".claude",
			"projects",
			"-Users-fixture-project",
			"11111111-2222-3333-4444-555555555555.jsonl",
		);
		const result = await new ClaudeCodeAdapter().sessions.collect({
			kind: "paths",
			paths: [changedPath],
		});
		expect(result.coverage).toBe("partial");
		expect(result.sessions.map((session) => session.localSessionId)).toEqual([
			"11111111-2222-3333-4444-555555555555",
		]);
	});
});

/**
 * Build a Claude Code session jsonl with the given uuids. The first line is
 * the session-start meta; the rest alternate user/assistant messages so that
 * `parseSessionJsonl` produces a non-empty `messages` array. Each line carries
 * a `uuid` so the dedupe pass can compare uuid sets across files.
 */
function makeJsonl(opts: {
	sessionId: string;
	cwd: string;
	uuids: string[];
	startTimestamp?: string;
}): string {
	const { sessionId, cwd, uuids } = opts;
	const startTs = opts.startTimestamp ?? "2026-04-23T06:45:31.915Z";
	const lines: string[] = [];
	lines.push(
		JSON.stringify({
			type: "session-start",
			sessionId,
			cwd,
			timestamp: startTs,
			version: "1.0.0",
			uuid: uuids[0],
		}),
	);
	for (let i = 1; i < uuids.length; i++) {
		const role = i % 2 === 1 ? "user" : "assistant";
		const ts = `2026-04-23T06:45:${String(31 + (i % 28)).padStart(2, "0")}.000Z`;
		const message =
			role === "user"
				? { role: "user", content: `user msg ${i}` }
				: {
						role: "assistant",
						model: "claude-opus-4-7",
						content: [{ type: "text", text: `assistant msg ${i}` }],
						usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
					};
		lines.push(JSON.stringify({ type: role, sessionId, timestamp: ts, uuid: uuids[i], message }));
	}
	return `${lines.join("\n")}\n`;
}

function writeResumeSessionFile(opts: {
	cwd: string;
	sessionId: string;
	uuids: string[];
	startTimestamp?: string;
}) {
	const projectDirName = opts.cwd.replace(/\//g, "-");
	const projectDir = join(tmpHome, ".claude", "projects", projectDirName);
	mkdirSync(projectDir, { recursive: true });
	const file = join(projectDir, `${opts.sessionId}.jsonl`);
	writeFileSync(file, makeJsonl(opts));
}

function uuidRange(prefix: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}`);
}

describe("ClaudeCodeAdapter dedupeResumeChains", () => {
	it("suppresses a queued predecessor when a successor appears before exact reread", async () => {
		const cwd = "/Users/fixture/resume-before-drain";
		const predecessorUuids = uuidRange("queued", 12);
		writeResumeSessionFile({ cwd, sessionId: "queued-predecessor", uuids: predecessorUuids });
		const adapter = new ClaudeCodeAdapter();
		expect(await adapter.sessions.resolve("queued-predecessor")).not.toBeNull();

		writeResumeSessionFile({
			cwd,
			sessionId: "new-successor",
			uuids: [...predecessorUuids, ...uuidRange("new", 4)],
		});

		expect(await adapter.sessions.resolve("queued-predecessor")).toBeNull();
		expect((await adapter.sessions.resolve("new-successor"))?.localSessionId).toBe("new-successor");
	});

	it("dedupes A when A.uuids ⊂ B.uuids in the same project (resume chain)", async () => {
		const cwd = "/Users/fixture/resume-test";
		const aUuids = uuidRange("u", 12);
		const bUuids = [...aUuids, ...uuidRange("v", 8)];

		writeResumeSessionFile({ cwd, sessionId: "aaaa-aaaa", uuids: aUuids });
		writeResumeSessionFile({
			cwd,
			sessionId: "bbbb-bbbb",
			uuids: bUuids,
			startTimestamp: "2026-04-24T04:40:43.360Z",
		});

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.sessions.collect({ kind: "complete", projectFilter: cwd });

		expect(result.dedupedCount).toBe(1);
		expect(result.sessions.map((s) => s.localSessionId)).toEqual(["bbbb-bbbb"]);
	});

	it("dedupes A and B in a 3-link chain A ⊂ B ⊂ C, keeping only C", async () => {
		const cwd = "/Users/fixture/resume-test-chain";
		const aUuids = uuidRange("u", 12);
		const bUuids = [...aUuids, ...uuidRange("v", 6)];
		const cUuids = [...bUuids, ...uuidRange("w", 4)];

		writeResumeSessionFile({ cwd, sessionId: "aaaa-aaaa", uuids: aUuids });
		writeResumeSessionFile({ cwd, sessionId: "bbbb-bbbb", uuids: bUuids });
		writeResumeSessionFile({ cwd, sessionId: "cccc-cccc", uuids: cUuids });

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.sessions.collect({ kind: "complete", projectFilter: cwd });

		expect(result.dedupedCount).toBe(2);
		expect(result.sessions.map((s) => s.localSessionId)).toEqual(["cccc-cccc"]);
	});

	it("keeps equal-sized resume leaves, including identical uuid sets", async () => {
		const cwd = "/Users/fixture/resume-branches";
		const shared = uuidRange("shared", 10);
		writeResumeSessionFile({ cwd, sessionId: "predecessor", uuids: shared });
		for (const [sessionId, suffix] of [
			["branch-a", "a"],
			["branch-a-copy", "a"],
			["branch-b", "b"],
		]) {
			writeResumeSessionFile({ cwd, sessionId, uuids: [...shared, suffix] });
		}

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.sessions.collect({ kind: "complete", projectFilter: cwd });
		expect(result.sessions.map((session) => session.localSessionId).sort()).toEqual([
			"branch-a",
			"branch-a-copy",
			"branch-b",
		]);
		expect(result.dedupedCount).toBe(1);
		expect(await adapter.sessions.resolve("predecessor")).toBeNull();
		expect((await adapter.sessions.resolve("branch-a-copy"))?.localSessionId).toBe("branch-a-copy");
	});

	it("does not dedupe across different projects even when uuid sets are subset", async () => {
		const aUuids = uuidRange("u", 12);
		const bUuids = [...aUuids, ...uuidRange("v", 8)];

		writeResumeSessionFile({
			cwd: "/Users/fixture/proj-cross-a",
			sessionId: "aaaa-aaaa",
			uuids: aUuids,
		});
		writeResumeSessionFile({
			cwd: "/Users/fixture/proj-cross-b",
			sessionId: "bbbb-bbbb",
			uuids: bUuids,
		});

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.sessions.collect({ kind: "complete" });
		// project to just the two we wrote — the fixture's pre-existing session
		// would otherwise pad the result count
		const ours = result.sessions.filter((s) =>
			["aaaa-aaaa", "bbbb-bbbb"].includes(s.localSessionId),
		);

		expect(result.dedupedCount).toBe(0);
		expect(ours.map((s) => s.localSessionId).sort()).toEqual(["aaaa-aaaa", "bbbb-bbbb"]);
	});

	it("does not dedupe when A is missing even one uuid (not a strict subset)", async () => {
		const cwd = "/Users/fixture/resume-near-miss";
		const shared = uuidRange("u", 11);
		const aUuids = [...shared, "a-only-extra"];
		const bUuids = [...shared, "b-only-1", "b-only-2", "b-only-3"];

		writeResumeSessionFile({ cwd, sessionId: "aaaa-aaaa", uuids: aUuids });
		writeResumeSessionFile({ cwd, sessionId: "bbbb-bbbb", uuids: bUuids });

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.sessions.collect({ kind: "complete", projectFilter: cwd });

		expect(result.dedupedCount).toBe(0);
		expect(result.sessions.map((s) => s.localSessionId).sort()).toEqual(["aaaa-aaaa", "bbbb-bbbb"]);
	});

	it("dedupes short predecessors when their UUIDs are a strict subset", async () => {
		const cwd = "/Users/fixture/resume-too-short";
		const aUuids = uuidRange("u", 5);
		const bUuids = [...aUuids, ...uuidRange("v", 15)];

		writeResumeSessionFile({ cwd, sessionId: "aaaa-aaaa", uuids: aUuids });
		writeResumeSessionFile({ cwd, sessionId: "bbbb-bbbb", uuids: bUuids });

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.sessions.collect({ kind: "complete", projectFilter: cwd });

		expect(result.dedupedCount).toBe(1);
		expect(result.sessions.map((s) => s.localSessionId).sort()).toEqual(["bbbb-bbbb"]);
	});

	it("does not dedupe a single session in a project (group of 1)", async () => {
		const cwd = "/Users/fixture/resume-singleton";
		writeResumeSessionFile({ cwd, sessionId: "aaaa-aaaa", uuids: uuidRange("u", 15) });

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.sessions.collect({ kind: "complete", projectFilter: cwd });

		expect(result.dedupedCount).toBe(0);
		expect(result.sessions).toHaveLength(1);
	});
});

describe("ClaudeCodeAdapter.collectSkills", () => {
	it("finds top-level skill directories with SKILL.md and skips SKIP_DIRS", async () => {
		const a = new ClaudeCodeAdapter();
		const skills = await a.skills.collect();
		const keys = skills.map((s) => s.skillKey).sort();
		// `node_modules` sits in the fixture as a negative case — the SKIP_DIRS
		// filter must drop it. `demo` is the one real skill.
		expect(keys).toEqual(["demo"]);
		const demo = skills.find((s) => s.skillKey === "demo")!;
		expect(demo.content).toContain("description: A demo skill");
		expect(demo.filePath).toContain("/.claude/skills/demo/SKILL.md");
	});

	it("adopts a pre-ledger bundled clawdi target without uploading it", async () => {
		const legacy = join(tmpHome, ".claude", "skills", "clawdi");
		cpSync(resolve(import.meta.dir, "../fixtures/legacy-local-clawdi"), legacy, {
			recursive: true,
		});
		const adapter = new ClaudeCodeAdapter();
		expect((await adapter.skills.collect()).map((skill) => skill.skillKey)).not.toContain("clawdi");
		expect(await adapter.skills.listKeys()).not.toContain("clawdi");
		expect(managedSkillReservationState(legacy, "clawdi")).toBe("reserved");

		releaseManagedSkill({
			targetDir: legacy,
			id: "clawdi",
			manager: "local-setup",
			removeTarget: () => undefined,
		});
		expect((await adapter.skills.collect()).map((skill) => skill.skillKey)).toContain("clawdi");
		expect(await adapter.skills.listKeys()).toContain("clawdi");
	});

	it("does not adopt a future clawdi Skill after an absent migration", async () => {
		const adapter = new ClaudeCodeAdapter();
		const target = join(tmpHome, ".claude", "skills", "clawdi");
		expect(await adapter.skills.listKeys()).not.toContain("clawdi");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "# User Skill\n");

		expect((await adapter.skills.collect()).map((skill) => skill.skillKey)).toContain("clawdi");
		expect(await adapter.skills.listKeys()).toContain("clawdi");
		expect(managedSkillReservationState(target, "clawdi")).toBe("unreserved");
	});
});

describe("ClaudeCodeAdapter.writeSkillArchive + getSkillPath", () => {
	it("round-trips a tar.gz (key matches archive internal dirname)", async () => {
		const src = join(tmpHome, ".claude", "skills", "demo");
		const bytes = await tarSkillDir(src);

		const a = new ClaudeCodeAdapter();
		await a.skills.writeArchive("demo", bytes);

		const extracted = join(tmpHome, ".claude", "skills", "demo", "SKILL.md");
		expect(existsSync(extracted)).toBe(true);
		expect(readFileSync(extracted, "utf-8")).toContain("name: demo");
	});

	it("blocks Cloud writes while reserved and permits the same write after release", async () => {
		const target = join(tmpHome, ".claude", "skills", "demo");
		const bytes = await tarSkillDir(target);
		reserveManagedSkill({
			targetDir: target,
			id: "demo",
			version: 1,
			digest: "d".repeat(64),
			manager: "local-setup",
		});
		const adapter = new ClaudeCodeAdapter();

		await expect(adapter.skills.writeArchive("demo", bytes)).rejects.toThrow("reserved");
		expect((await adapter.skills.collect()).map((skill) => skill.skillKey)).not.toContain("demo");

		releaseManagedSkill({
			targetDir: target,
			id: "demo",
			manager: "local-setup",
			removeTarget: () => rmSync(target, { recursive: true, force: true }),
		});
		await adapter.skills.writeArchive("demo", bytes);

		expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toContain("name: demo");
		expect((await adapter.skills.collect()).map((skill) => skill.skillKey)).toContain("demo");
		expect(await adapter.skills.listKeys()).toContain("demo");
	});

	it("getSkillPath returns skills/<key>/SKILL.md under Claude home", () => {
		const a = new ClaudeCodeAdapter();
		expect(a.skills.path("xyz")).toBe(join(tmpHome, ".claude", "skills", "xyz", "SKILL.md"));
	});
});
