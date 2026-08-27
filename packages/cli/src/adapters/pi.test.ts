import { afterEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PiAdapter } from "./pi";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryRoots: string[] = [];

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureSession(): { adapter: PiAdapter; file: string; root: string } {
	const root = mkdtempSync(join(tmpdir(), "clawdi-pi-adapter-"));
	temporaryRoots.push(root);
	process.env.PI_CODING_AGENT_DIR = root;
	const file = join(root, "sessions", "--workspace-demo--", "session.jsonl");
	mkdirSync(dirname(file), { recursive: true });
	copyFileSync(join(import.meta.dir, "../../tests/fixtures/pi/session-v3.jsonl"), file);
	return { adapter: new PiAdapter(), file, root };
}

function copyFixture(root: string, fixture: string, name: string): string {
	const file = join(root, "sessions", "--workspace-demo--", name);
	mkdirSync(dirname(file), { recursive: true });
	copyFileSync(join(import.meta.dir, `../../tests/fixtures/pi/${fixture}`), file);
	return file;
}

describe("Pi session adapter", () => {
	test("uploads private reasoning while projecting only the active visible tail", async () => {
		const { adapter, file, root } = fixtureSession();
		writeFileSync(file, readFileSync(file, "utf-8").replace(/\n$/, ""));
		expect(await adapter.detect()).toBe(true);
		expect(adapter.sessions.watchPaths()).toEqual([join(root, "sessions")]);

		const scan = await adapter.sessions.collect({ kind: "complete" });
		expect(scan.coverage).toBe("complete");
		expect(scan.sessions).toHaveLength(1);
		const session = scan.sessions[0];
		expect(session?.localSessionId).toBe("pi.fixture-session");
		expect(session?.events?.map((event) => event.type)).toEqual([
			"message",
			"message",
			"message",
			"reasoning",
			"tool_call",
			"reasoning",
			"tool_result",
			"message",
		]);
		const serialized = JSON.stringify(session?.events);
		expect(serialized).not.toContain("old prompt");
		expect(serialized).not.toContain("old answer");
		expect(serialized).not.toContain("abandoned branch");
		expect(serialized).toContain("hidden chain of thought");
		expect(serialized).toContain("opaque-tool-thought");
		expect(serialized).not.toContain("thinkingSignature");
		expect(serialized).not.toContain("hidden extension state");
		expect(serialized).toContain("Visible compaction summary");
		expect(serialized).toContain("retained prompt");
		expect(serialized).toContain("visible answer");
		expect(serialized).toContain("visible extension note");
		expect(serialized).toContain('"availability":"metadata_only"');
		expect(serialized).toContain('"sha256":');
		expect(serialized).not.toContain("inline:sha256:");
		expect(JSON.stringify(session?.messages)).not.toContain("hidden chain of thought");

		const pathScan = await adapter.sessions.collect({ kind: "paths", paths: [file] });
		expect(pathScan.coverage).toBe("partial");
		expect(pathScan.sessions[0]?.localSessionId).toBe("pi.fixture-session");
	});

	test("ignores a partial tail and resolves the completed backing store on retry", async () => {
		const { adapter, file } = fixtureSession();
		appendFileSync(file, '{"type":"message"');
		const partial = await adapter.sessions.resolve("pi.fixture-session");
		expect(JSON.stringify(partial?.events)).not.toContain("new answer");

		appendFileSync(
			file,
			',"id":"e9","parentId":"e8","timestamp":"2026-08-25T10:00:09.000Z","message":{"role":"assistant","content":[{"type":"text","text":"new answer"}],"provider":"anthropic","model":"claude-sonnet","timestamp":1787652009000}}\n',
		);
		const completed = await adapter.sessions.resolve("fixture-session");
		expect(JSON.stringify(completed?.events)).toContain("new answer");
	});

	test("migrates the official v1 compaction and hook-message shape deterministically", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-pi-v1-"));
		temporaryRoots.push(root);
		process.env.PI_CODING_AGENT_DIR = root;
		copyFixture(root, "session-v1.jsonl", "legacy.jsonl");
		const session = await new PiAdapter().sessions.resolve("pi.legacy-session");
		const serialized = JSON.stringify(session?.events);
		expect(serialized).toContain("Legacy visible summary");
		expect(serialized).toContain("kept legacy prompt");
		expect(serialized).toContain("visible migrated hook");
		expect(serialized).not.toContain("old legacy prompt");
		expect(serialized).not.toContain("old legacy answer");
		expect(session?.events?.every((event, index) => event.seq === index)).toBe(true);
	});

	test("reads the official v4 main lane and materialized compaction tail", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-pi-v4-"));
		temporaryRoots.push(root);
		process.env.PI_CODING_AGENT_DIR = root;
		copyFixture(root, "session-v4.jsonl", "current.jsonl");

		const session = await new PiAdapter().sessions.resolve("pi.v4-session");
		expect(session).toMatchObject({
			localSessionId: "pi.v4-session",
			projectPath: "/workspace/v4",
			inputTokens: 42,
			outputTokens: 7,
			cacheReadTokens: 11,
		});
		const serialized = JSON.stringify(session?.events);
		expect(serialized).toContain("Visible v4 compaction summary");
		expect(serialized).toContain("retained v4 prompt");
		expect(serialized).toContain("retained v4 answer");
		expect(serialized).toContain("visible v4 tool result");
		expect(serialized).toContain("final v4 answer");
		expect(serialized).not.toContain("abandoned answer");
		expect(serialized).not.toContain("abandoned private reasoning");
		expect(serialized).not.toContain("thinkingSignature");
		expect(session?.events).toContainEqual(
			expect.objectContaining({
				type: "reasoning",
				kind: "redacted",
				payload_json: '{"signature":"private"}',
			}),
		);
	});
});
