import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "./base";
import { OpenClawAdapter } from "./openclaw";
import { PiAdapter } from "./pi";
import { piMessageDrafts } from "./pi-message-drafts";
import type { JsonObject } from "./rich-event-mapping";

const original = {
	pi: process.env.PI_CODING_AGENT_DIR,
	openclaw: process.env.OPENCLAW_STATE_DIR,
	path: process.env.PATH,
};
const roots: string[] = [];

afterEach(() => {
	for (const [key, value] of [
		["PI_CODING_AGENT_DIR", original.pi],
		["OPENCLAW_STATE_DIR", original.openclaw],
		["PATH", original.path],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const cases: Array<[string, JsonObject]> = [
	[
		"assistant",
		{
			role: "assistant",
			model: "fixture-model",
			content: [
				{ type: "thinking", thinking: "reasoning", thinkingSignature: "opaque-thinking" },
				{ type: "text", text: "answer" },
				{
					type: "toolCall",
					id: "call",
					name: "read",
					arguments: {
						path: "README.md",
						signature: "hidden-argument",
						nested: { signature: "hidden-nested", count: 1 },
					},
					thoughtSignature: "opaque-tool",
				},
				{
					type: "toolCall",
					id: "string-call",
					name: "read",
					arguments: '{"signature":"hidden-string","path":"README.md"}',
				},
			],
		},
	],
	[
		"toolResult",
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: "output",
			details: { thinkingSignature: "opaque-result", count: 1 },
		},
	],
	["bashExecution", { role: "bashExecution", command: "pwd", output: "/workspace", exitCode: 0 }],
	["custom", { role: "custom", display: true, content: "visible custom message" }],
	[
		"deferred",
		{
			role: "assistant",
			stopReason: "deferred",
			content: [{ type: "text", text: "deferred answer" }],
		},
	],
];

function drafts(events: readonly SessionEvent[]) {
	return events.map(({ seq: _seq, event_id: _id, source, ...draft }) => ({
		...draft,
		source: {
			record_id: source.record_id,
			record_seq: source.record_seq,
			part_index: source.part_index,
		},
	}));
}

describe("shared Pi message projection", () => {
	test("keeps redacted thinking as opaque reasoning without placeholder text", () => {
		const events = piMessageDrafts(
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "[Reasoning redacted]",
						redacted: true,
						thinkingSignature: "opaque-redacted",
					},
				],
			},
			{
				recordId: "redacted",
				source: () => ({ adapter: "pi", session_key: "fixture", record_id: "redacted" }),
			},
		);
		expect(events).toEqual([
			{
				type: "reasoning",
				kind: "redacted",
				parts: [],
				payload_json: '{"signature":"opaque-redacted"}',
				source: { adapter: "pi", session_key: "fixture", record_id: "redacted" },
			},
		]);
		expect(JSON.stringify(events)).not.toContain("[Reasoning redacted]");
	});

	test("accepts the OpenClaw gateway lowercase toolcall display type", () => {
		const events = piMessageDrafts(
			{
				role: "assistant",
				content: [
					{ type: "toolcall", id: "gateway-call", name: "read", arguments: { path: "README.md" } },
				],
			},
			{
				recordId: "gateway",
				source: (partIndex) => ({
					adapter: "openclaw",
					session_key: "fixture",
					record_id: "gateway",
					part_index: partIndex,
				}),
			},
		);
		expect(events).toEqual([
			{
				type: "tool_call",
				call_id: "gateway-call",
				name: "read",
				arguments_json: '{"path":"README.md"}',
				source: {
					adapter: "openclaw",
					session_key: "fixture",
					record_id: "gateway",
					part_index: 1,
				},
			},
		]);
	});
	test.each(cases)(
		"projects identical %s drafts through Pi and OpenClaw",
		async (_name, message) => {
			const root = mkdtempSync(join(tmpdir(), "clawdi-pi-message-projection-"));
			roots.push(root);
			const pi = join(root, "pi");
			const openclaw = join(root, "openclaw");
			const ocSessions = join(openclaw, "agents", "main", "sessions");
			mkdirSync(join(pi, "sessions"), { recursive: true });
			mkdirSync(ocSessions, { recursive: true });
			const records = [
				{
					type: "session",
					version: 3,
					id: "fixture",
					cwd: "/workspace",
					timestamp: "2026-10-06T01:00:00.000Z",
				},
				{
					type: "message",
					id: "prompt",
					parentId: null,
					timestamp: "2026-10-06T01:00:01.000Z",
					message: { role: "user", content: "prompt" },
				},
				{
					type: "message",
					id: "reply",
					parentId: "prompt",
					timestamp: "2026-10-06T01:00:02.000Z",
					message,
				},
			];
			const transcript = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
			writeFileSync(join(pi, "sessions", "fixture.jsonl"), transcript);
			writeFileSync(join(ocSessions, "fixture.jsonl"), transcript);
			writeFileSync(
				join(ocSessions, "sessions.json"),
				JSON.stringify({
					fixture: { sessionId: "fixture", updatedAt: 1791248402000, model: null },
				}),
			);
			process.env.PI_CODING_AGENT_DIR = pi;
			process.env.OPENCLAW_STATE_DIR = openclaw;
			process.env.PATH = root;
			const piSession = (await new PiAdapter().sessions.collect({ kind: "complete" })).sessions[0];
			const ocSession = (await new OpenClawAdapter().sessions.collect({ kind: "complete" }))
				.sessions[0];
			if (!piSession?.events || !ocSession?.events)
				throw new Error("Expected adapter event fixtures");
			expect(drafts(piSession.events)).toEqual(drafts(ocSession.events));
			const calls = piSession.events.filter((event) => event.type === "tool_call");
			if (_name === "assistant") {
				expect(calls.map((call) => call.arguments_json)).toEqual([
					'{"nested":{"count":1},"path":"README.md"}',
					'{"path":"README.md"}',
				]);
				expect(JSON.stringify(calls)).not.toContain("hidden-");
				expect(JSON.stringify(piSession.events)).toContain("opaque-tool");
			}
		},
	);
});
