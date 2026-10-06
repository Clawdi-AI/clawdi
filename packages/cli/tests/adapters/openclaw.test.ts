import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SessionScanBatch, scanSessionModule } from "../../src/adapters/base";
import { OpenClawAdapter } from "../../src/adapters/openclaw";
import { SESSION_PROJECTION_REVISION } from "../../src/adapters/rich-event-mapping";
import {
	assertProjectionGolden,
	assertSessionGolden,
} from "../../src/adapters/session-golden.test-support";
import { projectEventsToMessages } from "../../src/lib/session-events";
import { tarSkillDir } from "../../src/lib/tar";
import { log } from "../../src/serve/log";
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
if [ "$*" = "sessions --json --agent main --limit all" ]; then
  set -- sessions --json --all-agents --limit all
fi
if [ -f "$HOME/.openclaw/command-log" ]; then
  printf 'start:%s\n' "$1" >> "$HOME/.openclaw/command-log"
  trap 'printf "end:%s\n" "$1" >> "$HOME/.openclaw/command-log"' EXIT
fi
if [ -f "$HOME/.openclaw/delay-$1" ]; then
  touch "$HOME/.openclaw/running-$1"
  sleep 0.2
  rm "$HOME/.openclaw/running-$1"
fi
if [ -f "$HOME/.openclaw/fail-once-$1" ]; then
  rm "$HOME/.openclaw/fail-once-$1"
  exit 1
fi
if [ "$*" = "sessions --json --all-agents --limit all" ] && [ -f "$HOME/.openclaw/legacy-inventory-test" ]; then
  printf '{"path":null,"stores":[{"agentId":"main","path":"%s/.openclaw/agents/main/sessions/sessions.json"}],"allAgents":true,"sessions":[{"agentId":"main","key":"agent:main:main","sessionId":"oc-session-001","updatedAt":1776247205000,"sessionFile":"%s/.openclaw/agents/main/sessions/oc-session-001.jsonl","model":"claude-opus-4-7","inputTokens":12,"outputTokens":6,"cacheRead":2,"displayName":"Fixture session","acp":{"cwd":"/Users/fixture/project","lastActivityAt":1776247205000}}]}\n' "$HOME" "$HOME"
  exit 0
fi
if [ "$*" = "sessions --json --all-agents --limit all" ] && [ -f "$HOME/.openclaw/sqlite-session-test" ]; then
  updated_at=1776247205000
  if [ -f "$HOME/.openclaw/sqlite-session-updated-at" ]; then updated_at=$(cat "$HOME/.openclaw/sqlite-session-updated-at"); fi
  printf '{"path":null,"stores":[{"agentId":"main","path":"%s/.openclaw/agents/main/agent/openclaw-agent.sqlite"}],"allAgents":true,"sessions":[{"agentId":"main","key":"agent:main:main","sessionId":"sqlite-session-001","updatedAt":%s,"sessionStartedAt":1776247200000,"sessionFile":"%s/.openclaw/agents/main/sessions/sqlite-session-001.jsonl","model":"gpt-5.6-sol","modelProvider":"openai","inputTokens":8,"outputTokens":5,"cacheRead":2,"label":"Active SQLite branch"}]}\n' "$HOME" "$updated_at" "$HOME"
  exit 0
fi
if [ "$*" = "sessions --json --all-agents --limit all" ] && [ -f "$HOME/.openclaw/session-key-only-test" ]; then
  printf '%s\n' '{"path":null,"stores":[],"allAgents":true,"sessions":[{"agentId":"main","key":"agent:main:main","kind":"direct","updatedAt":1776247205000},{"agentId":"main","key":"agent:main:cron:daily","kind":"cron","updatedAt":1776247205000}]}'
  exit 0
fi
if [ "$1 $2 $3" = "gateway call chat.history" ] && [ -f "$HOME/.openclaw/paged-history-test" ]; then
  case "$5" in
    *'"offset":0'*) printf '%s\n' '{"messages":[{"id":"new","role":"user","content":"new question","timestamp":"2026-04-15T10:00:02.000Z"}],"hasMore":true,"nextOffset":1}' ;;
    *)
      if [ -f "$HOME/.openclaw/pagination-failure-test" ]; then exit 1; fi
      printf '%s\n' '{"messages":[{"id":"old","role":"user","content":"old question","timestamp":"2026-04-15T10:00:01.000Z"}],"hasMore":false}' ;;
  esac
  exit 0
fi
if [ "$1 $2 $3" = "gateway call chat.history" ] && [ -f "$HOME/.openclaw/sqlite-session-test" ]; then
  case "$*" in *sessionId*) exit 1 ;; esac
  printf '%s\n' '{"messages":[{"id":"active-user","role":"user","content":"kept question","timestamp":"2026-04-15T10:00:00.000Z"},{"id":"active-assistant","parentId":"active-user","role":"assistant","content":"kept answer","model":"gpt-5.6-sol","timestamp":"2026-04-15T10:00:05.000Z"}],"hasMore":false}'
  exit 0
fi
if [ "$1 $2 $3" = "gateway call chat.history" ] && [ -f "$HOME/.openclaw/session-key-only-test" ]; then
  case "$*" in *sessionId*) exit 1 ;; esac
  case "$*" in *agent:main:cron:daily*) exit 1 ;; esac
  printf '%s\n' '{"messages":[{"id":"key-only-user","role":"user","content":"key-only question","timestamp":"2026-04-15T10:00:00.000Z"}],"hasMore":false}'
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

function installOfficialTranscriptFixture(
	messages: Array<Record<string, unknown>>,
	surface: "sdk" | "gateway",
	model = "gpt-5.5",
) {
	const stateRoot = join(tmpHome, ".openclaw");
	const sqlitePath = join(stateRoot, "agents", "main", "agent", "openclaw-agent.sqlite");
	mkdirSync(join(stateRoot, "agents", "main", "agent"), { recursive: true });
	writeFileSync(sqlitePath, "fixture");
	rmSync(join(stateRoot, "agents", "main", "sessions", "sessions.json"));
	writeFileSync(
		join(stateRoot, "official-inventory.json"),
		JSON.stringify({
			stores: [{ agentId: "main", path: sqlitePath }],
			sessions: [
				{
					agentId: "main",
					key: "agent:main:main",
					sessionId: "official-fixture",
					updatedAt: 1776247205000,
					model,
					acp: { cwd: "/workspace" },
				},
			],
		}),
	);
	writeFileSync(
		join(stateRoot, "official-history.json"),
		JSON.stringify({ messages, hasMore: false }),
	);
	writeFileSync(
		join(tmpHome, "bin", "openclaw"),
		`#!/bin/sh
if [ "$1" = "sessions" ]; then cat "$HOME/.openclaw/official-inventory.json"; exit 0; fi
if [ "$1 $2 $3" = "gateway call chat.history" ]; then cat "$HOME/.openclaw/official-history.json"; exit 0; fi
if [ "$1 $2" = "agents list" ]; then printf '[{"id":"main","workspace":"%s/.openclaw/agents/main"}]' "$HOME"; exit 0; fi
exit 1
`,
	);
	if (surface === "sdk") {
		const packageRoot = join(tmpHome, ".local", "lib", "node_modules", "openclaw");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "openclaw",
				type: "module",
				exports: { "./plugin-sdk/session-transcript-runtime": "./session-transcript-runtime.js" },
			}),
		);
		writeFileSync(
			join(packageRoot, "session-transcript-runtime.js"),
			`export async function readVisibleSessionTranscriptMessageEntries() { return ${JSON.stringify(messages.map((message) => ({ entryId: message.id, createdAt: message.timestamp, message })))}; }`,
		);
	}
}

describe("OpenClawAdapter.detect", () => {
	it.each(["version", "empty", "failed"])("reads only --version (%s)", async (mode) => {
		const log = join(tmpHome, "version-arguments.log");
		writeFileSync(
			join(tmpHome, "bin", "openclaw"),
			`#!/bin/sh
printf '%s\\n' "$1" >> "${log}"
if [ "$1" = "--version" ]; then
  ${mode === "failed" ? "exit 1" : mode === "empty" ? "exit 0" : "printf '%s\\n' 'OpenClaw 2026.9.8 (fixture)'"}
else
  printf '%s\\n' 'Usage: OpenClaw help banner'
fi
`,
		);
		expect(await new OpenClawAdapter().getVersion()).toBe(
			mode === "version" ? "OpenClaw 2026.9.8 (fixture)" : null,
		);
		expect(readFileSync(log, "utf8")).toBe("--version\n");
	});

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
	it("preserves origin/main Gateway session bytes and localHash", async () => {
		const stateRoot = join(tmpHome, ".openclaw");
		const agentRoot = join(stateRoot, "agents", "main", "agent");
		mkdirSync(agentRoot, { recursive: true });
		writeFileSync(join(agentRoot, "openclaw-agent.sqlite"), "fixture");
		writeFileSync(join(stateRoot, "sqlite-session-test"), "enabled");
		rmSync(join(stateRoot, "agents", "main", "sessions", "sessions.json"));
		await assertSessionGolden("openclaw-gateway", new OpenClawAdapter().sessions);
	});

	it("preserves origin/main legacy session bytes and localHash", async () => {
		rmSync(join(tmpHome, "bin", "openclaw"));
		process.env.PATH = join(tmpHome, "bin");
		await assertSessionGolden("openclaw-legacy", new OpenClawAdapter().sessions);
	});
	it("preserves origin/main session bytes and localHash", async () => {
		await assertSessionGolden("openclaw", new OpenClawAdapter().sessions);
	});
	it.each(["none", "sessions", "gateway", "agents"])(
		"serializes scan/resolve/roster subprocesses (injected failure: %s)",
		async (failingCommand) => {
			const stateRoot = join(tmpHome, ".openclaw");
			const commandLog = join(stateRoot, "command-log");
			writeFileSync(commandLog, "");
			writeFileSync(join(stateRoot, "sqlite-session-test"), "enabled");
			for (const command of ["sessions", "gateway", "agents"]) {
				writeFileSync(join(stateRoot, `delay-${command}`), "enabled");
			}
			if (failingCommand !== "none")
				writeFileSync(join(stateRoot, `fail-once-${failingCommand}`), "enabled");

			const adapter = new OpenClawAdapter();
			const [scan, resolution, skills] = await Promise.allSettled([
				adapter.sessions.scan({ kind: "complete" }, new Map()),
				adapter.sessions.resolve("sqlite-session-001"),
				adapter.skills.listKeys(),
			]);
			expect(scan.status).toBe("fulfilled");
			expect(resolution.status).toBe("fulfilled");
			if (failingCommand === "agents") {
				expect(skills).toMatchObject({
					status: "rejected",
					reason: {
						message: "OpenClaw workspace resolution requires `openclaw agents list --json`",
					},
				});
			} else {
				expect(skills).toEqual({ status: "fulfilled", value: ["demo"] });
			}
			expect(await adapter.skills.listKeys()).toEqual(["demo"]);
			const recovered = await adapter.sessions.resolve("sqlite-session-001");
			expect(recovered?.messages.map((message) => message.content)).toEqual([
				"kept question",
				"kept answer",
			]);
			if (failingCommand !== "none")
				expect(existsSync(join(stateRoot, `fail-once-${failingCommand}`))).toBe(false);

			const events = readFileSync(commandLog, "utf8").trim().split("\n");
			expect(events.filter((event) => event === "start:sessions")).toHaveLength(3);
			expect(events.filter((event) => event === "start:agents")).toHaveLength(2);
			expect(events).toContain("start:gateway");
			let active = 0;
			let peak = 0;
			for (const event of events) {
				active += event.startsWith("start:") ? 1 : -1;
				peak = Math.max(peak, active);
				expect(active).toBeGreaterThanOrEqual(0);
			}
			expect(active).toBe(0);
			expect(peak).toBe(1);
		},
	);

	it.each(["sessions", "gateway", "agents"])(
		"keeps the event loop responsive while %s is running",
		async (command) => {
			const stateRoot = join(tmpHome, ".openclaw");
			writeFileSync(join(stateRoot, "sqlite-session-test"), "enabled");
			writeFileSync(join(stateRoot, `delay-${command}`), "enabled");
			let observedRunning = false;
			const timer = setInterval(() => {
				observedRunning ||= existsSync(join(stateRoot, `running-${command}`));
			}, 10);
			try {
				const adapter = new OpenClawAdapter();
				if (command === "agents") {
					expect(await adapter.skills.listKeys()).toEqual(["demo"]);
				} else {
					const { sessions } = await adapter.sessions.collect({ kind: "complete" });
					expect(sessions[0]?.messages.map((message) => message.content)).toEqual([
						"kept question",
						"kept answer",
					]);
				}
				expect(observedRunning).toBe(true);
			} finally {
				clearInterval(timer);
			}
		},
	);

	describe.each(["sessions", "gateway"])("%s failure fallback", (command) => {
		it.each([
			["nonzero exit", `printf '%s' '{"sessions":[],"messages":[]}'; exit 1`],
			["invalid JSON", "printf 'invalid JSON'; exit 0"],
		])("resolves the legacy transcript after %s", async (_failure, response) => {
			writeFileSync(join(tmpHome, ".openclaw", "legacy-inventory-test"), "enabled");
			const executable = join(tmpHome, "bin", "openclaw");
			writeFileSync(
				executable,
				readFileSync(executable, "utf8").replace(
					"#!/bin/sh",
					`#!/bin/sh\nif [ "$1" = "${command}" ]; then ${response}; fi`,
				),
			);

			const session = await new OpenClawAdapter().sessions.resolve("oc-session-001");

			expect(session?.messages.map((message) => message.content)).toEqual(["hello", "world"]);
		});
	});

	it("falls back to the legacy inventory when the executable is missing", async () => {
		rmSync(join(tmpHome, "bin", "openclaw"));
		process.env.PATH = join(tmpHome, "bin");

		const { sessions } = await new OpenClawAdapter().sessions.collect({ kind: "complete" });

		expect(sessions.map((session) => session.localSessionId)).toEqual(["oc-session-001"]);
	});

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
		expect(s.realUserInputAt).toBe("2026-04-20T10:00:00.000Z");
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

	for (const surface of ["sdk", "gateway"] as const) {
		it.each(["delivery-mirror", "gateway-injected", "acp-runtime", "automation-result"])(
			`keeps %s content without model attribution through ${surface}`,
			async (model) => {
				installOfficialTranscriptFixture(
					[
						{
							id: "real",
							role: "assistant",
							provider: "openai",
							model: "gpt-5.5",
							content: "Real answer",
							timestamp: "2026-04-15T10:00:00.000Z",
						},
						{
							id: "bookkeeping",
							role: "assistant",
							provider: "openclaw",
							model,
							content: "Delivered answer",
							openclawDeliveryMirror: { kind: "cron-direct-delivery-context" },
							timestamp: "2026-04-15T10:00:05.000Z",
						},
					],
					surface,
				);
				for (const streaming of [false, true]) {
					const session = await new OpenClawAdapter().sessions.resolve("official-fixture", {
						streaming,
						signal: new AbortController().signal,
					});
					if (!session) throw new Error("Expected bookkeeping fixture");
					expect(session.model).toBe("gpt-5.5");
					expect(session.modelsUsed).toEqual(["gpt-5.5"]);
					const events = [];
					for await (const event of session.readEvents?.() ?? session.events ?? [])
						events.push(event);
					expect(events).toHaveLength(2);
					expect(events[0]).toMatchObject({ model: "gpt-5.5" });
					expect(events[1]).toMatchObject({
						type: "message",
						parts: [{ type: "text", text: "Delivered answer" }],
					});
					expect(events[1]).not.toHaveProperty("model");
				}
			},
		);
		it(`uses inventory model for ACP transcripts through ${surface}`, async () => {
			installOfficialTranscriptFixture(
				[
					{
						id: "acp",
						role: "assistant",
						provider: "openclaw",
						model: "acp-runtime",
						content: "ACP answer",
						timestamp: "2026-04-15T10:00:05.000Z",
					},
				],
				surface,
				"claude-opus-4-7",
			);
			const session = await new OpenClawAdapter().sessions.resolve("official-fixture");
			expect(session?.model).toBe("claude-opus-4-7");
			expect(session?.modelsUsed).toEqual(["claude-opus-4-7"]);
			expect(session?.messages.map((message) => message.content)).toEqual(["ACP answer"]);
			expect(session?.events?.[0]).not.toHaveProperty("model");
		});
	}

	it.each(["sdk", "gateway"] as const)(
		"preserves visible history for display:false messages through %s",
		async (surface) => {
			const messages = [
				{
					id: "visible-user",
					role: "user",
					content: "Visible question",
					timestamp: "2026-04-15T10:00:00.000Z",
				},
				{
					id: "hidden-user",
					role: "user",
					display: false,
					content: [
						{ type: "text", text: "Internal coordination" },
						{ type: "tool_result", tool_use_id: "internal-call", content: "Internal result" },
					],
					timestamp: "2026-04-15T10:00:01.000Z",
				},
				{
					id: "hidden-assistant",
					role: "assistant",
					display: false,
					content: [
						{ type: "text", text: "Internal report" },
						{ type: "thinking", thinking: "Internal reasoning" },
						{ type: "toolCall", id: "internal-call", name: "read", arguments: {} },
					],
					timestamp: "2026-04-15T10:00:02.000Z",
				},
				{
					id: "visible-assistant",
					role: "assistant",
					content: "Visible answer",
					model: "gpt-5.5",
					timestamp: "2026-04-15T10:00:05.000Z",
				},
			];
			// The public Gateway display projection already filters display:false rows.
			installOfficialTranscriptFixture(
				surface === "sdk" ? messages : messages.filter((message) => message.display !== false),
				surface,
			);
			for (const streaming of [false, true]) {
				const session = await new OpenClawAdapter().sessions.resolve("official-fixture", {
					streaming,
					signal: new AbortController().signal,
				});
				if (!session) throw new Error("Expected hidden OpenClaw fixture");
				const events = [];
				for await (const event of session.readEvents?.() ?? session.events ?? [])
					events.push(event);
				expect(projectEventsToMessages(events).map((message) => message.content)).toEqual([
					"Visible question",
					"Visible answer",
				]);
				expect(session.messageCount).toBe(2);
				const hiddenEvents = events.filter((event) => event.source.record_id.startsWith("hidden-"));
				if (surface === "sdk") {
					expect(hiddenEvents.map((event) => event.type)).toEqual([
						"message",
						"tool_result",
						"message",
						"reasoning",
						"tool_call",
					]);
					for (const event of hiddenEvents)
						expect(event.semantics).toEqual({
							lifecycle: "active",
							display: "hidden",
							compressed_summary: false,
						});
				} else expect(hiddenEvents).toHaveLength(0);
			}
		},
	);

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
  console.log("[state/agent-db] agent database integrity gate");
  return [
    { entryId: "sdk-user", createdAt: "2026-04-15T10:00:00.000Z", message: { role: "user", content: "SDK question" } },
    { entryId: "sdk-assistant", parentId: "sdk-user", createdAt: "2026-04-15T10:00:05.000Z", message: { role: "assistant", content: "SDK answer", model: "gpt-5.6-sol" } },
  ];
}
`,
		);
		rmSync(join(stateRoot, "agents", "main", "sessions", "sessions.json"));
		writeFileSync(join(stateRoot, "command-log"), "");

		const sessions = (await new OpenClawAdapter("main").sessions.collect({ kind: "complete" }))
			.sessions;

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.messages.map((message) => message.content)).toEqual([
			"SDK question",
			"SDK answer",
		]);
		expect(sessions[0]?.realUserInputAt).toBe("2026-04-15T10:00:00.000Z");
		expect(sessions[0]?.events?.map((event) => event.source.record_id)).toEqual([
			"sdk-user",
			"sdk-assistant",
		]);
		expect(readFileSync(join(stateRoot, "command-log"), "utf8")).not.toContain("start:gateway");
		assertProjectionGolden("openclaw-sdk", sessions[0]?.events);
	});

	it.each([
		{ source: "export const unsupported = true;", failure: "missing_export", exitCode: 2 },
		{ source: "process.exit(9);", failure: "exit_code", exitCode: 9 },
		{
			source: "export const readVisibleSessionTranscriptMessageEntries = () => ({});",
			failure: "parse_failure",
			exitCode: undefined,
		},
	])("warns before SDK fallback ($failure)", async ({ source, failure, exitCode }) => {
		installOfficialTranscriptFixture(
			[
				{
					id: "gateway-user",
					role: "user",
					content: "Gateway question",
					timestamp: "2026-04-15T10:00:00.000Z",
				},
			],
			"sdk",
		);
		writeFileSync(
			join(tmpHome, ".local", "lib", "node_modules", "openclaw", "session-transcript-runtime.js"),
			source,
		);
		const warning = spyOn(log, "warn").mockImplementation(() => {});
		try {
			const { sessions } = await new OpenClawAdapter().sessions.collect({ kind: "complete" });
			expect(sessions[0]?.messages[0]?.content).toBe("Gateway question");
			expect(warning).toHaveBeenCalledWith(
				"openclaw.transcript_sdk_fallback",
				expect.objectContaining({
					failure,
					fallback: "gateway",
					...(exitCode === undefined ? {} : { exit_code: exitCode }),
				}),
			);
		} finally {
			warning.mockRestore();
		}
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
		expect(sessions[0]?.realUserInputAt).toBe("2026-04-15T10:00:00.000Z");
		expect(await adapter.sessions.resolve("sqlite-session-001")).toEqual(sessions[0] ?? null);
		expect(await adapter.sessions.resolve("missing-session")).toBeNull();
		expect(adapter.sessions.watchPaths()).toContain(sqlitePath);
		expect(adapter.sessions.watchPaths()).toContain(`${sqlitePath}-wal`);
		expect(adapter.sessions.watchPaths()).toContain(`${sqlitePath}-journal`);
	});

	it("spools Gateway pages in chronological order and rejects incomplete pagination", async () => {
		const stateRoot = join(tmpHome, ".openclaw");
		mkdirSync(join(stateRoot, "agents", "main", "agent"), { recursive: true });
		writeFileSync(join(stateRoot, "agents", "main", "agent", "openclaw-agent.sqlite"), "fixture");
		writeFileSync(join(stateRoot, "sqlite-session-test"), "enabled");
		writeFileSync(join(stateRoot, "paged-history-test"), "enabled");
		rmSync(join(stateRoot, "agents", "main", "sessions", "sessions.json"));
		const adapter = new OpenClawAdapter();
		const { sessions } = await adapter.sessions.collect({ kind: "complete" });
		expect(sessions[0]?.messages.map((message) => message.content)).toEqual([
			"old question",
			"new question",
		]);
		writeFileSync(join(stateRoot, "pagination-failure-test"), "enabled");
		expect((await adapter.sessions.collect({ kind: "complete" })).sessions).toEqual([]);
	});

	it("classifies official sessionKey-only entries through Gateway history", async () => {
		const sessionsRoot = join(tmpHome, ".openclaw", "agents", "main", "sessions");
		rmSync(sessionsRoot, { recursive: true, force: true });
		mkdirSync(sessionsRoot, { recursive: true });
		writeFileSync(join(tmpHome, ".openclaw", "session-key-only-test"), "enabled");

		const scan = await scanSessionModule(new OpenClawAdapter().sessions, { kind: "complete" });
		const sessions = [];
		for await (const batch of scan.batches) sessions.push(...batch.sessions);

		expect(sessions).toEqual([]);
		expect(scan.userActivity).toEqual({
			lastUserInputAt: "2026-04-15T10:00:00.000Z",
			complete: true,
		});
	});

	it.each([false, true])("reprojects pre-versioned revisions (legacy=%s)", async (legacy) => {
		if (legacy) writeFileSync(join(tmpHome, ".openclaw", "legacy-inventory-test"), "enabled");
		const scan = await scanSessionModule(
			new OpenClawAdapter().sessions,
			{ kind: "complete" },
			new Map([
				["oc-session-001", `p${SESSION_PROJECTION_REVISION - 1}:oc-session-001:1776247205000`],
			]),
		);
		const sessions = [];
		for await (const batch of scan.batches) sessions.push(...batch.sessions);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.sourceRevision).toBe(
			`p${SESSION_PROJECTION_REVISION}:oc-session-001:1776247205000`,
		);
	});

	it("reads legacy inventory JSONL without requiring a live Gateway", async () => {
		writeFileSync(join(tmpHome, ".openclaw", "legacy-inventory-test"), "enabled");
		const sessionsDir = join(tmpHome, ".openclaw", "agents", "main", "sessions");
		writeFileSync(
			join(sessionsDir, "orphan.jsonl.deleted.2026-09-01"),
			`${JSON.stringify({ role: "user", content: "archived input", timestamp: "2026-08-19T00:00:00Z" })}\n`,
		);

		const scan = await scanSessionModule(new OpenClawAdapter().sessions, { kind: "complete" });
		const sessions = [];
		for await (const batch of scan.batches) sessions.push(...batch.sessions);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			localSessionId: "oc-session-001",
			projectPath: "/Users/fixture/project",
			messageCount: 2,
			sourceRevision: `p${SESSION_PROJECTION_REVISION}:oc-session-001:1776247205000`,
		});
		expect(scan.userActivity).toEqual({
			lastUserInputAt: "2026-08-19T00:00:00.000Z",
			complete: true,
		});
	});

	it("uses official current activity and only inventories archives during baseline", async () => {
		const stateRoot = join(tmpHome, ".openclaw");
		const sessionsRoot = join(stateRoot, "agents", "main", "sessions");
		const packageRoot = join(tmpHome, ".local", "lib", "node_modules", "openclaw");
		const readLog = join(stateRoot, "transcript-reads.log");
		mkdirSync(join(stateRoot, "agents", "main", "agent"), { recursive: true });
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(join(stateRoot, "agents", "main", "agent", "openclaw-agent.sqlite"), "fixture");
		writeFileSync(join(stateRoot, "sqlite-session-test"), "enabled");
		const currentPath = join(sessionsRoot, "sqlite-session-001.jsonl");
		writeFileSync(currentPath, "{");
		const archivePath = join(sessionsRoot, "sqlite-session-001.jsonl.deleted.2026-09-01");
		writeFileSync(
			archivePath,
			`${JSON.stringify({ role: "user", content: "archived input", timestamp: "2026-08-16T10:00:00Z" })}\n`,
		);
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
			`import { appendFileSync } from "node:fs";
export async function readVisibleSessionTranscriptMessageEntries() {
  appendFileSync(${JSON.stringify(readLog)}, "read\\n");
  return [
    { entryId: "sdk-user", createdAt: "2026-04-15T10:00:00.000Z", message: { role: "user", content: "question" } },
    { entryId: "sdk-assistant", parentId: "sdk-user", createdAt: "2026-04-15T10:00:05.000Z", message: { role: "assistant", content: "answer" } },
  ];
}
`,
		);

		const adapter = new OpenClawAdapter();
		const first = await scanSessionModule(adapter.sessions, { kind: "complete" });
		const firstBatches: SessionScanBatch[] = [];
		for await (const batch of first.batches) firstBatches.push(batch);
		const revision = firstBatches[0]?.sessions[0]?.sourceRevision;
		expect(revision).toBe(`p${SESSION_PROJECTION_REVISION}:sqlite-session-001:1776247205000`);
		expect(first.userActivity).toEqual({
			lastUserInputAt: "2026-08-16T10:00:00.000Z",
			complete: true,
		});
		expect(readFileSync(readLog, "utf8")).toBe("read\n");
		rmSync(currentPath);
		const missingCurrent = await scanSessionModule(adapter.sessions, { kind: "complete" });
		expect(missingCurrent.userActivity).toEqual({
			lastUserInputAt: "2026-08-16T10:00:00.000Z",
			complete: true,
		});
		expect(readFileSync(readLog, "utf8")).toBe("read\nread\n");
		writeFileSync(archivePath, "{");

		const unchanged = await scanSessionModule(
			adapter.sessions,
			{ kind: "complete" },
			new Map([["sqlite-session-001", revision ?? ""]]),
		);
		const unchangedBatches: SessionScanBatch[] = [];
		for await (const batch of unchanged.batches) unchangedBatches.push(batch);
		expect(unchangedBatches[0]?.sessions).toEqual([]);
		expect(unchangedBatches[0]?.observedLocalSessionIds).toEqual(["sqlite-session-001"]);
		expect(unchanged.userActivity).toEqual({ lastUserInputAt: null, complete: true });
		expect(readFileSync(readLog, "utf8")).toBe("read\nread\n");

		writeFileSync(join(stateRoot, "sqlite-session-updated-at"), "1776247206000");
		const changed = await scanSessionModule(
			adapter.sessions,
			{ kind: "complete" },
			new Map([["sqlite-session-001", revision ?? ""]]),
		);
		const changedBatches: SessionScanBatch[] = [];
		for await (const batch of changed.batches) changedBatches.push(batch);
		expect(changedBatches[0]?.sessions[0]?.sourceRevision).toBe(
			`p${SESSION_PROJECTION_REVISION}:sqlite-session-001:1776247206000`,
		);
		expect(changed.userActivity).toEqual({
			lastUserInputAt: "2026-04-15T10:00:00.000Z",
			complete: true,
		});
		expect(readFileSync(readLog, "utf8")).toBe("read\nread\nread\n");
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

	it("classifies stale, orphaned, and internal OpenClaw archives from the canonical inventory", async () => {
		const sessionsDir = join(tmpHome, ".openclaw", "agents", "main", "sessions");
		const internal = join(sessionsDir, "internal.jsonl");
		writeFileSync(
			join(sessionsDir, "stale.jsonl.deleted.2026-09-01"),
			`${JSON.stringify({ role: "user", content: "archived input", timestamp: "2026-08-20T00:00:00Z" })}\n`,
		);
		writeFileSync(
			join(sessionsDir, "orphan.jsonl.reset.2026-09-02"),
			`${JSON.stringify({ role: "user", content: "orphan input", timestamp: "2026-08-21T00:00:00Z" })}\n`,
		);
		writeFileSync(`${internal}.deleted.2026-09-03`, "{");
		writeFileSync(internal, "{");
		writeFileSync(
			join(sessionsDir, "media.jsonl"),
			`${JSON.stringify({ role: "user", content: [{ type: "image", url: "local" }], timestamp: "2026-08-24T00:00:00Z" })}\n`,
		);
		writeFileSync(
			join(sessionsDir, "sessions.json"),
			JSON.stringify({
				main: { sessionId: "stale", updatedAt: 1776247205000 },
				"agent:main:cron:daily": { sessionFile: internal, updatedAt: 1776247205000 },
				media: { sessionId: "media", updatedAt: 1776247205000 },
			}),
		);

		const scan = await scanSessionModule(new OpenClawAdapter().sessions, { kind: "complete" });

		expect(scan.userActivity).toEqual({
			lastUserInputAt: "2026-08-24T00:00:00.000Z",
			complete: true,
		});
	});

	it("keeps a trustworthy OpenClaw timestamp while an archive tail is incomplete", async () => {
		const sessionsDir = join(tmpHome, ".openclaw", "agents", "main", "sessions");
		writeFileSync(join(sessionsDir, "sessions.json"), "{}");
		writeFileSync(
			join(sessionsDir, "orphan.jsonl.deleted.2026-09-03"),
			`${JSON.stringify({ role: "user", content: "known input", timestamp: "2026-08-23T00:00:00Z" })}\n{`,
		);

		const scan = await scanSessionModule(new OpenClawAdapter().sessions, { kind: "complete" });

		expect(scan.userActivity).toEqual({
			lastUserInputAt: "2026-08-23T00:00:00.000Z",
			complete: false,
		});
	});
});

describe("OpenClaw profile reader", () => {
	it("reads an explicit named agent independently of the default selector", async () => {
		addFinancialAgent(join(tmpHome, ".openclaw"));
		process.env.OPENCLAW_AGENT_ID = "main";
		const reader = new OpenClawAdapter("financial").sessions;
		const result = await reader.collect({ kind: "complete" });
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]?.localSessionId).toBe("oc-financial-001");
		expect(reader.watchPaths()).toEqual([
			join(tmpHome, ".openclaw", "agents", "financial", "sessions"),
		]);
	});
	it("keeps explicit home and activity isolated from the global state directory", async () => {
		const stateRoot = join(tmpHome, "other-openclaw");
		addFinancialAgent(stateRoot, "isolated-session");
		process.env.OPENCLAW_STATE_DIR = join(tmpHome, ".openclaw");
		const reader = new OpenClawAdapter("financial", stateRoot).sessions;
		const scan = await scanSessionModule(reader, { kind: "complete" });
		const sessions = [];
		for await (const batch of scan.batches) sessions.push(...batch.sessions);
		expect(sessions.map((session) => session.localSessionId)).toEqual(["isolated-session"]);
		expect(scan.userActivity?.complete).toBeTrue();
		expect(reader.watchPaths()).toEqual([join(stateRoot, "agents", "financial", "sessions")]);
	});
});

describe("OpenClawAdapter.collectSkills", () => {
	it("lists only the selected agent's Skills and rejects a missing agent", async () => {
		addFinancialAgent(join(tmpHome, ".openclaw"));
		const adapter = new OpenClawAdapter();
		expect(await adapter.skills.listKeys()).toEqual(["demo"]);
		process.env.OPENCLAW_AGENT_ID = " financial ";
		expect(await adapter.skills.listKeys()).toEqual(["fin-skill"]);
		process.env.OPENCLAW_AGENT_ID = "missing";
		await expect(adapter.skills.listKeys()).rejects.toThrow(
			"OpenClaw agent missing is not present in the official agent roster",
		);
	});

	it("finds demo skill under agents/<id>/skills/ and skips SKIP_DIRS", async () => {
		const a = new OpenClawAdapter();
		const skills = await a.skills.collect();
		// Fixture has demo/ (real) and node_modules/ (SKIP_DIRS sentinel).
		expect(skills.map((s) => s.skillKey)).toEqual(["demo"]);
	});

	it("collects only the default agent skills, matching reconciliation", async () => {
		addFinancialAgent(join(tmpHome, ".openclaw"));
		const a = new OpenClawAdapter();
		const keys = (await a.skills.collect()).map((s) => s.skillKey).sort();
		expect(keys).toEqual(["demo"]);
		expect(await a.skills.listKeys()).toEqual(keys);
		process.env.OPENCLAW_AGENT_ID = "financial";
		expect((await a.skills.collect()).map((s) => s.skillKey)).toEqual(["fin-skill"]);
		expect(await a.skills.listKeys()).toEqual(["fin-skill"]);
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
