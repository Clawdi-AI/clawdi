import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code";
import { assertProjectionGolden } from "../../src/adapters/session-golden.test-support";
import { prepareSessionUpload } from "../../src/lib/session-upload";
import { log } from "../../src/serve/log";
import { sessionPathSnapshot } from "../../src/serve/sessions-watcher";
import { cleanupTmp, copyFixtureToTmp } from "./helpers";

let tmpHome: string;
let originalHome: string | undefined;
let originalConfigDir: string | undefined;
let projectRoot: string;
const fixturePath = join(import.meta.dir, "../fixtures/claude-subagent.jsonl");

beforeEach(() => {
	originalHome = process.env.HOME;
	originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
	delete process.env.CLAUDE_CONFIG_DIR;
	tmpHome = copyFixtureToTmp("claude_code");
	process.env.HOME = tmpHome;
	projectRoot = join(tmpHome, ".claude", "projects", "-Users-fixture-project");
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
	cleanupTmp(tmpHome);
});

function writeSubagent(parent: string, agent = "child", content?: string): string {
	const path = join(projectRoot, parent, "subagents", `agent-${agent}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	if (content === undefined) cpSync(fixturePath, path);
	else writeFileSync(path, content);
	return path;
}

describe("Claude subagent transcripts", () => {
	test("keeps identical agent names under distinct parents and resolves their independent ids", async () => {
		const adapter = new ClaudeCodeAdapter();
		const parent = (await adapter.sessions.collect({ kind: "complete" })).sessions[0];
		if (!parent) throw new Error("expected parent fixture");
		const parentHash = (await prepareSessionUpload(parent, "events-v1")).localHash;
		const firstPath = writeSubagent("parent-a");
		const secondPath = writeSubagent("parent-b");
		const paths = new Map([
			["parent-a.agent-child", firstPath],
			["parent-b.agent-child", secondPath],
		]);
		for (const streaming of [false, true]) {
			const context = { streaming, signal: new AbortController().signal };
			const result = await adapter.sessions.collect({ kind: "complete" }, context);
			expect(result.sessions.map((session) => session.localSessionId).sort()).toEqual(
				[parent.localSessionId, ...paths.keys()].sort(),
			);
			for (const [id, path] of paths) {
				const session = await adapter.sessions.resolve(id, context);
				expect(session).toMatchObject({
					localSessionId: id,
					rawFilePath: path,
					messageCount: 2,
					summary: "Subagent task",
				});
				if (!session) throw new Error("expected resolved subagent fixture");
				const upload = await prepareSessionUpload(session, "events-v1");
				const events = [];
				for await (const event of upload.readEvents?.() ?? upload.events ?? []) {
					events.push(event);
					expect(event.source.session_key).toBe(id);
				}
				if (id === "parent-a.agent-child") assertProjectionGolden("claude-subagent", events);
			}
		}
		const currentParent = await adapter.sessions.resolve(parent.localSessionId);
		if (!currentParent) throw new Error("expected unchanged parent");
		expect((await prepareSessionUpload(currentParent, "events-v1")).localHash).toBe(parentHash);
		expect(currentParent.events).toEqual(parent.events);
	});

	test("splits subagent ids at the first .agent- marker", async () => {
		const path = writeSubagent("parent-a", "child.agent-nested");
		expect(
			await new ClaudeCodeAdapter().sessions.resolve("parent-a.agent-child.agent-nested"),
		).toMatchObject({ rawFilePath: path });
	});

	test("applies resume subset dedupe only to parents", async () => {
		const records = readFileSync(fixturePath, "utf8").replaceAll(
			"/Users/fixture/project",
			"/Users/fixture/subagent-dedupe",
		);
		const extra = `${JSON.stringify({ type: "assistant", uuid: "extra-answer", timestamp: "2026-10-06T01:00:02.000Z", message: { role: "assistant", content: "Extra answer" } })}\n`;
		writeFileSync(join(projectRoot, "parent-a.jsonl"), `${records}${extra}`);
		writeFileSync(join(projectRoot, "parent-b.jsonl"), records);
		writeSubagent("parent-a", "subset", records);
		writeSubagent("parent-a", "equal", records);
		writeSubagent(
			"parent-a",
			"superset",
			`${records}${extra}${JSON.stringify({ type: "user", uuid: "subagent-only", timestamp: "2026-10-06T01:00:03.000Z", message: { role: "user", content: "Subagent continuation" } })}\n`,
		);
		const result = await new ClaudeCodeAdapter().sessions.collect({ kind: "complete" });
		expect(result.dedupedCount).toBe(1);
		expect(result.sessions.map((session) => session.localSessionId).sort()).toEqual([
			"11111111-2222-3333-4444-555555555555",
			"parent-a",
			"parent-a.agent-equal",
			"parent-a.agent-subset",
			"parent-a.agent-superset",
		]);
	});

	test("incrementally scans only the affected project for a nested subagent path", async () => {
		const path = writeSubagent("parent-a");
		const other = join(
			tmpHome,
			".claude",
			"projects",
			"-Users-fixture-other",
			"other-parent",
			"subagents",
			"agent-other.jsonl",
		);
		mkdirSync(dirname(other), { recursive: true });
		cpSync(fixturePath, other);
		const result = await new ClaudeCodeAdapter().sessions.collect({ kind: "paths", paths: [path] });
		expect(result.coverage).toBe("partial");
		expect(result.sessions.map((session) => session.localSessionId).sort()).toEqual([
			"11111111-2222-3333-4444-555555555555",
			"parent-a.agent-child",
		]);
	});

	test.each(["bad name", "x".repeat(190)])(
		"skips invalid or oversized subagent ids with a structured warning (%s)",
		async (agent) => {
			writeSubagent("parent-name", agent);
			const warning = spyOn(log, "warn").mockImplementation(() => {});
			try {
				const adapter = new ClaudeCodeAdapter();
				const result = await adapter.sessions.collect({ kind: "complete" });
				expect(result.sessions).toHaveLength(1);
				expect(warning).toHaveBeenCalledWith(
					"claude_code.invalid_session_id_skipped",
					expect.objectContaining({ reason: "invalid_local_session_id" }),
				);
				expect(await adapter.sessions.resolve(`parent-name.agent-${agent}`)).toBeNull();
			} finally {
				warning.mockRestore();
			}
		},
	);

	test("watches nested subagent appends within the existing recursive projects scope", async () => {
		const adapter = new ClaudeCodeAdapter();
		const path = writeSubagent("parent-a");
		const root = join(tmpHome, ".claude", "projects");
		expect(adapter.sessions.watchPaths()).toEqual([root]);
		const before = await sessionPathSnapshot(root);
		expect(before.entries?.has(path)).toBe(true);
		writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
		const after = await sessionPathSnapshot(root);
		expect(after.signature).not.toBe(before.signature);
		expect(after.entries?.get(path)).not.toBe(before.entries?.get(path));
	});
});
