import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenClawAdapter } from "../../src/adapters/openclaw";
import { tarSkillDir } from "../../src/lib/tar";
import { cleanupTmp, copyFixtureToTmp } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origStateDir: string | undefined;
let origAgentId: string | undefined;
let origPath: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origStateDir = process.env.OPENCLAW_STATE_DIR;
	origAgentId = process.env.OPENCLAW_AGENT_ID;
	origPath = process.env.PATH;
	delete process.env.OPENCLAW_STATE_DIR;
	delete process.env.OPENCLAW_AGENT_ID;
	tmpHome = copyFixtureToTmp("openclaw");
	process.env.HOME = tmpHome;
	const bin = join(tmpHome, "bin");
	mkdirSync(bin, { recursive: true });
	const command = join(bin, "openclaw");
	writeFileSync(
		command,
		`#!/bin/sh
if [ "$*" = "sessions --json --all-agents --limit all" ] && [ -f "$HOME/.openclaw/sqlite-session-test" ]; then
  printf '{"path":null,"stores":[{"agentId":"main","path":"%s/.openclaw/agents/main/agent/openclaw-agent.sqlite"}],"allAgents":true,"sessions":[{"agentId":"main","key":"agent:main:main","sessionId":"sqlite-session-001","updatedAt":1776247205000,"sessionStartedAt":1776247200000,"model":"gpt-5.6-sol","modelProvider":"openai","inputTokens":8,"outputTokens":5,"cacheRead":2,"label":"Active SQLite branch"}]}\n' "$HOME"
  exit 0
fi
if [ "$1 $2 $3" = "gateway call chat.history" ] && [ -f "$HOME/.openclaw/sqlite-session-test" ]; then
  printf '%s\n' '{"messages":[{"id":"active-user","role":"user","content":"kept question","timestamp":"2026-04-15T10:00:00.000Z"},{"id":"active-assistant","parentId":"active-user","role":"assistant","content":"kept answer","model":"gpt-5.6-sol","timestamp":"2026-04-15T10:00:05.000Z"}],"hasMore":false}'
  exit 0
fi
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"%s/.openclaw/agents/main"}' "$HOME"
  if [ -d "$HOME/.openclaw/agents/financial" ]; then printf ',{"id":"financial","workspace":"%s/.openclaw/agents/financial"}' "$HOME"; fi
  printf ']\n'
  exit 0
fi
if [ "$1 $2" = "skills install" ]; then
  source="$3"; shift 3; slug=""
  while [ "$#" -gt 0 ]; do [ "$1" = "--as" ] && slug="$2" && shift; shift; done
  rm -rf "$HOME/.openclaw/agents/main/skills/$slug"
  mkdir -p "$HOME/.openclaw/agents/main/skills/$slug"
  cp -R "$source/." "$HOME/.openclaw/agents/main/skills/$slug/"
  exit 0
fi
exit 1
`,
	);
	chmodSync(command, 0o755);
	process.env.PATH = `${bin}:${origPath ?? ""}`;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origStateDir) process.env.OPENCLAW_STATE_DIR = origStateDir;
	else delete process.env.OPENCLAW_STATE_DIR;
	if (origAgentId) process.env.OPENCLAW_AGENT_ID = origAgentId;
	else delete process.env.OPENCLAW_AGENT_ID;
	if (origPath !== undefined) process.env.PATH = origPath;
	else delete process.env.PATH;
	cleanupTmp(tmpHome);
});

/**
 * Drop a second agent (`financial`) into the fixture with one session — used
 * to verify the multi-agent scanning fix from issue #28.
 */
function addFinancialAgent(stateRoot: string, sessionId = "oc-financial-001") {
	const agentRoot = join(stateRoot, "agents", "financial");
	mkdirSync(join(agentRoot, "sessions"), { recursive: true });
	mkdirSync(join(agentRoot, "skills", "fin-skill"), { recursive: true });
	writeFileSync(
		join(agentRoot, "sessions", "sessions.json"),
		JSON.stringify({
			[sessionId]: {
				sessionId,
				updatedAt: 1776247300000,
				sessionFile: `${sessionId}.jsonl`,
				model: "gpt-5.3-codex",
				inputTokens: 5,
				outputTokens: 3,
				cacheRead: 0,
				displayName: "Financial briefing",
				acp: { cwd: "/Users/fixture/finance", lastActivityAt: 1776247300000 },
			},
		}),
	);
	writeFileSync(
		join(agentRoot, "sessions", `${sessionId}.jsonl`),
		[
			JSON.stringify({
				type: "message",
				timestamp: 1776247200000,
				message: { role: "user", content: "stocks" },
			}),
			JSON.stringify({
				type: "message",
				timestamp: 1776247205000,
				message: { role: "assistant", content: "analyzing" },
			}),
		].join("\n"),
	);
	writeFileSync(
		join(agentRoot, "skills", "fin-skill", "SKILL.md"),
		"---\nname: fin-skill\ndescription: Finance assistant\n---\n",
	);
}

describe("OpenClawAdapter.detect", () => {
	it("returns true when $HOME/.openclaw exists", async () => {
		const a = new OpenClawAdapter();
		expect(await a.detect()).toBe(true);
	});

	it("detects alternative home names (.clawdbot / .moltbot) via getOpenClawHome", async () => {
		// Point HOME to a dir that has .clawdbot but not .openclaw, with a
		// real agent dir inside so the stricter detect() (sessions index OR
		// agent dir) recognizes it as a usable install.
		const alt = `${tmpHome}-alt`;
		mkdirSync(join(alt, ".clawdbot", "agents", "main"), { recursive: true });
		process.env.HOME = alt;
		const a = new OpenClawAdapter();
		expect(await a.detect()).toBe(true);
		// cleanup
		const { rmSync } = await import("node:fs");
		rmSync(alt, { recursive: true, force: true });
	});

	it("honors $OPENCLAW_STATE_DIR override", async () => {
		process.env.HOME = `/tmp/clawdi-nowhere-${Date.now()}`;
		process.env.OPENCLAW_STATE_DIR = join(tmpHome, ".openclaw");
		const a = new OpenClawAdapter();
		expect(await a.detect()).toBe(true);
	});
});

describe("OpenClawAdapter.collectSessions", () => {
	it("parses the fixture session with index metadata + transcript messages", async () => {
		const a = new OpenClawAdapter();
		const { sessions, dedupedCount } = await a.sessions.collect({ kind: "complete" });
		expect(sessions).toHaveLength(1);
		expect(dedupedCount).toBe(0);
		const s = sessions[0]!;
		expect(s).toMatchObject({
			localSessionId: "oc-session-001",
			projectPath: "/Users/fixture/project",
			model: "claude-opus-4-7",
			messageCount: 2,
			inputTokens: 12,
			outputTokens: 6,
			cacheReadTokens: 2,
		});
		expect(s.messages).toHaveLength(2);
		expect(s.messages[0]!).toMatchObject({ role: "user", content: "hello" });
		expect(s.messages[1]!).toMatchObject({
			role: "assistant",
			content: "world",
			model: "claude-opus-4-7",
		});
	});

	it("uploads thinking while keeping the message projection visible-only", async () => {
		const sessionPath = join(
			tmpHome,
			".openclaw",
			"agents",
			"main",
			"sessions",
			"oc-session-001.jsonl",
		);
		const record = {
			type: "message",
			timestamp: "2026-04-20T10:00:03.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private OpenClaw thought", signature: "signed" },
					{ type: "text", text: "visible OpenClaw answer" },
				],
			},
		};
		writeFileSync(
			sessionPath,
			`${readFileSync(sessionPath, "utf-8").trimEnd()}\n${JSON.stringify(record)}\n`,
		);

		const session = (await new OpenClawAdapter().sessions.collect({ kind: "complete" }))
			.sessions[0];
		expect(session?.events).toContainEqual(
			expect.objectContaining({
				type: "reasoning",
				kind: "thinking",
				parts: [{ type: "text", text: "private OpenClaw thought" }],
				payload_json: '{"signature":"signed"}',
			}),
		);
		expect(session?.messages.at(-1)?.content).toBe("visible OpenClaw answer");
		expect(JSON.stringify(session?.messages)).not.toContain("private OpenClaw thought");
	});

	it("uses displayName as summary", async () => {
		const a = new OpenClawAdapter();
		const s = (await a.sessions.collect({ kind: "complete" })).sessions[0]!;
		expect(s.summary).toBe("Fixture session");
	});

	it("filters by projectFilter matching acp.cwd", async () => {
		const a = new OpenClawAdapter();
		expect(
			(await a.sessions.collect({ kind: "complete", projectFilter: "/Users/fixture/project" }))
				.sessions,
		).toHaveLength(1);
		expect(
			(await a.sessions.collect({ kind: "complete", projectFilter: "/Users/other/project" }))
				.sessions,
		).toHaveLength(0);
	});

	it("returns empty when sessions.json is missing", async () => {
		rmSync(join(tmpHome, ".openclaw", "agents", "main", "sessions", "sessions.json"));
		// Also remove the fixture's `agents/main` dir so listAgentDirs returns
		// no candidates. (Otherwise scanning continues over the dir, finds no
		// index, and short-circuits — same observable behavior, but only by
		// accident.)
		rmSync(join(tmpHome, ".openclaw", "agents", "main"), { recursive: true, force: true });
		const a = new OpenClawAdapter();
		expect((await a.sessions.collect({ kind: "complete" })).sessions).toEqual([]);
	});

	it("reads SQLite sessions through OpenClaw's public transcript SDK", async () => {
		const stateRoot = join(tmpHome, ".openclaw");
		const sqlitePath = join(stateRoot, "agents", "main", "agent", "openclaw-agent.sqlite");
		const packageRoot = join(tmpHome, ".local", "lib", "node_modules", "openclaw");
		mkdirSync(join(stateRoot, "agents", "main", "agent"), { recursive: true });
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(sqlitePath, "fixture");
		writeFileSync(join(stateRoot, "sqlite-session-test"), "enabled");
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "openclaw",
				type: "module",
				exports: {
					"./plugin-sdk/session-transcript-runtime": "./session-transcript-runtime.js",
				},
			}),
		);
		writeFileSync(
			join(packageRoot, "session-transcript-runtime.js"),
			`export async function readVisibleSessionTranscriptMessageEntries() {
  return [
    { entryId: "sdk-user", createdAt: "2026-04-15T10:00:00.000Z", message: { role: "user", content: "SDK question" } },
    { entryId: "sdk-assistant", parentId: "sdk-user", createdAt: "2026-04-15T10:00:05.000Z", message: { role: "assistant", content: "SDK answer", model: "gpt-5.6-sol" } },
  ];
}
`,
		);
		rmSync(join(stateRoot, "agents", "main", "sessions", "sessions.json"));

		const sessions = (await new OpenClawAdapter().sessions.collect({ kind: "complete" })).sessions;

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.messages.map((message) => message.content)).toEqual([
			"SDK question",
			"SDK answer",
		]);
	});

	it("falls back to OpenClaw's public Gateway transcript projection", async () => {
		const stateRoot = join(tmpHome, ".openclaw");
		const sqlitePath = join(stateRoot, "agents", "main", "agent", "openclaw-agent.sqlite");
		mkdirSync(join(stateRoot, "agents", "main", "agent"), { recursive: true });
		writeFileSync(sqlitePath, "fixture");
		writeFileSync(join(stateRoot, "sqlite-session-test"), "enabled");
		rmSync(join(stateRoot, "agents", "main", "sessions", "sessions.json"));

		const adapter = new OpenClawAdapter();
		const { sessions } = await adapter.sessions.collect({ kind: "complete" });

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			localSessionId: "sqlite-session-001",
			messageCount: 2,
			model: "gpt-5.6-sol",
			rawFilePath: sqlitePath,
			summary: "Active SQLite branch",
		});
		expect(sessions[0]?.messages.map((message) => message.content)).toEqual([
			"kept question",
			"kept answer",
		]);
		expect(adapter.sessions.watchPaths()).toContain(sqlitePath);
	});

	it("scans every agents/<id>/ subdir (issue #28)", async () => {
		// Default fixture has `main`. Drop in a second agent and confirm both
		// are picked up without setting OPENCLAW_AGENT_ID.
		addFinancialAgent(join(tmpHome, ".openclaw"));
		const a = new OpenClawAdapter();
		const { sessions } = await a.sessions.collect({ kind: "complete" });
		const ids = sessions.map((s) => s.localSessionId).sort();
		expect(ids).toEqual(["oc-financial-001", "oc-session-001"]);
	});

	it("watches every personality and narrows concrete transcript changes", async () => {
		addFinancialAgent(join(tmpHome, ".openclaw"));
		const adapter = new OpenClawAdapter();
		const mainSessions = join(tmpHome, ".openclaw", "agents", "main", "sessions");
		const financialSessions = join(tmpHome, ".openclaw", "agents", "financial", "sessions");
		expect(adapter.sessions.watchPaths().sort()).toEqual([mainSessions, financialSessions].sort());
		const bounded = await adapter.sessions.collect({
			kind: "paths",
			paths: [join(financialSessions, "oc-financial-001.jsonl")],
		});
		expect(bounded.coverage).toBe("partial");
		expect(bounded.sessions.map((session) => session.localSessionId)).toEqual(["oc-financial-001"]);
		const ambiguous = await adapter.sessions.collect({
			kind: "paths",
			paths: [
				join(financialSessions, "sessions.json"),
				join(financialSessions, "oc-financial-001.jsonl"),
			],
		});
		expect(ambiguous.coverage).toBe("complete");
		expect(ambiguous.sessions.map((session) => session.localSessionId).sort()).toEqual([
			"oc-financial-001",
			"oc-session-001",
		]);
	});

	it("handles production schema: composite index keys + absolute sessionFile", async () => {
		// Mirror what real openclaw writes: index keyed by `agent:main:…`
		// composite strings, with the UUID in `entry.sessionId` and an
		// absolute `sessionFile` path. Earlier code used the index key as
		// `localSessionId` and `path.join`-ed the absolute sessionFile onto
		// the sessions dir, which produced a non-existent path and silently
		// dropped every entry.
		const sessionsDir = join(tmpHome, ".openclaw", "agents", "main", "sessions");
		const uuid = "11111111-2222-3333-4444-555555555555";
		const transcriptAbs = join(sessionsDir, `${uuid}.jsonl`);
		writeFileSync(
			join(sessionsDir, "sessions.json"),
			JSON.stringify({
				"agent:main:main": {
					sessionId: uuid,
					updatedAt: 1776247205000,
					sessionFile: transcriptAbs,
					model: "claude-opus-4-7",
					inputTokens: 4,
					outputTokens: 2,
					cacheRead: 1,
					displayName: "Telegram chat",
					acp: { cwd: "/Users/fixture/project", lastActivityAt: 1776247205000 },
				},
			}),
		);
		writeFileSync(
			transcriptAbs,
			[
				JSON.stringify({
					type: "message",
					timestamp: 1776247200000,
					message: { role: "user", content: "hi" },
				}),
				JSON.stringify({
					type: "message",
					timestamp: 1776247205000,
					message: { role: "assistant", content: "hello" },
				}),
			].join("\n"),
		);

		const a = new OpenClawAdapter();
		const { sessions } = await a.sessions.collect({ kind: "complete" });
		expect(sessions).toHaveLength(1);
		const s = sessions[0]!;
		// localSessionId must be the UUID, not the composite index key.
		expect(s.localSessionId).toBe(uuid);
		expect(s.messageCount).toBe(2);
		expect(s.summary).toBe("Telegram chat");
	});

	it("OPENCLAW_AGENT_ID still narrows to a single agent", async () => {
		addFinancialAgent(join(tmpHome, ".openclaw"));
		process.env.OPENCLAW_AGENT_ID = "financial";
		const a = new OpenClawAdapter();
		const { sessions } = await a.sessions.collect({ kind: "complete" });
		expect(sessions.map((s) => s.localSessionId)).toEqual(["oc-financial-001"]);
	});
});

describe("OpenClawAdapter.collectSkills", () => {
	it("finds demo skill under agents/<id>/skills/ and skips SKIP_DIRS", async () => {
		const a = new OpenClawAdapter();
		const skills = await a.skills.collect();
		// Fixture has demo/ (real) and node_modules/ (SKIP_DIRS sentinel).
		expect(skills.map((s) => s.skillKey)).toEqual(["demo"]);
	});

	it("does not scan a hidden managed Skill recovery directory", async () => {
		const recovery = join(
			tmpHome,
			".openclaw",
			"agents",
			"main",
			"skills",
			".clawdi-previous-test",
		);
		mkdirSync(recovery, { recursive: true });
		writeFileSync(join(recovery, "SKILL.md"), "# Managed recovery artifact\n");

		const adapter = new OpenClawAdapter();
		expect((await adapter.skills.collect()).map((skill) => skill.skillKey)).not.toContain(
			".clawdi-previous-test",
		);
		expect(await adapter.skills.listKeys()).not.toContain(".clawdi-previous-test");
	});

	it("unions skills across agents/<id>/skills/ dirs (issue #28)", async () => {
		addFinancialAgent(join(tmpHome, ".openclaw"));
		const a = new OpenClawAdapter();
		const keys = (await a.skills.collect()).map((s) => s.skillKey).sort();
		expect(keys).toEqual(["demo", "fin-skill"]);
	});
});

describe("OpenClawAdapter.writeSkillArchive + getSkillPath", () => {
	it("round-trips a tar.gz into the agent skills dir", async () => {
		const bytes = await tarSkillDir(join(tmpHome, ".openclaw", "agents", "main", "skills", "demo"));

		const a = new OpenClawAdapter();
		await a.skills.writeArchive("demo", bytes);

		const extracted = join(tmpHome, ".openclaw", "agents", "main", "skills", "demo", "SKILL.md");
		expect(existsSync(extracted)).toBe(true);
		expect(readFileSync(extracted, "utf-8")).toContain("name: demo");
	});
});
