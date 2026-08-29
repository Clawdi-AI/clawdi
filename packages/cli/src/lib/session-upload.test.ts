import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawSession, SessionEvent } from "../adapters/base";
import { PiAdapter } from "../adapters/pi";
import { ApiClient } from "./api-client";
import {
	advanceEventHead,
	EMPTY_EVENT_HEAD,
	projectEventsToMessages,
	sequenceSessionEvents,
} from "./session-events";
import {
	negotiateSessionProtocol,
	planSessionUpload,
	sessionFence,
	syncSessionContent,
} from "./session-upload";
import { readFencedSessionEntry, readSessionsLock } from "./sessions-lock";

const originalHome = process.env.HOME;
const originalClawdiHome = process.env.CLAWDI_HOME;
const roots: string[] = [];

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-session-upload-"));
	roots.push(root);
	process.env.HOME = root;
	process.env.CLAWDI_HOME = join(root, ".clawdi");
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
	else process.env.CLAWDI_HOME = originalClawdiHome;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(recordId: string, text: string): SessionEvent {
	return sequenceSessionEvents([
		{
			type: "message",
			role: "assistant",
			parts: [{ type: "text", text }],
			source: {
				adapter: "pi",
				session_key: "fixture",
				record_id: recordId,
			},
		},
	])[0] as SessionEvent;
}

function events(...values: Array<[string, string]>): SessionEvent[] {
	return sequenceSessionEvents(
		values.map(([recordId, text]) => ({
			type: "message" as const,
			role: "assistant" as const,
			parts: [{ type: "text" as const, text }],
			source: {
				adapter: "pi" as const,
				session_key: "fixture",
				record_id: recordId,
			},
		})),
	);
}

function rawSession(content: readonly SessionEvent[]): RawSession {
	return {
		localSessionId: "pi.fixture",
		projectPath: "/workspace",
		startedAt: new Date("2026-08-25T00:00:00Z"),
		endedAt: null,
		messageCount: content.length,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		model: null,
		modelsUsed: [],
		durationSeconds: null,
		summary: null,
		messages: projectEventsToMessages(content),
		events: [...content],
		rawFilePath: "/sessions/fixture.jsonl",
		sourceRevision: "source-r1",
	};
}

function eventApi(): ApiClient {
	const api = new ApiClient({ requireAuth: false });
	api.getSessionUploadCapabilities = async () => ({
		protocols: ["snapshot-v1", "events-v1"],
		event_chunk_target_bytes: 1024 * 1024,
		event_chunk_max_bytes: 8 * 1024 * 1024,
	});
	return api;
}

describe("session upload negotiation and integrity", () => {
	it("falls back on an old server and refuses a mismatched stored hash", async () => {
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = input instanceof Request ? input : new Request(input, init);
				const path = new URL(request.url).pathname;
				if (path === "/v1/sessions/upload-capabilities") {
					return new Response('{"detail":"Not found"}', { status: 404 });
				}
				if (path === "/v1/sessions/pi.fixture/upload") {
					return Response.json({
						status: "uploaded",
						file_key: "sessions/wrong.json",
						content_hash: "f".repeat(64),
					});
				}
				return new Response("unexpected request", { status: 500 });
			}) as typeof fetch;
			const api = new ApiClient({ requireAuth: false });
			const protocol = await negotiateSessionProtocol(api, new PiAdapter().sessions);
			expect(protocol).toBe("snapshot-v1");
			const session = rawSession([event("one", "visible")]);
			const plan = planSessionUpload(session, protocol);
			const fence = sessionFence(api, {
				environmentId: "agent-pi",
				adapter: "pi",
				sourceSessionKey: session.localSessionId,
			});

			await expect(
				syncSessionContent({
					api,
					fence,
					session,
					plan,
					needsSnapshotContent: true,
				}),
			).rejects.toThrow(/server stored hash/);
			expect(readFencedSessionEntry(readSessionsLock(), fence)).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("persists an oversized legacy snapshot as blocked without a request", async () => {
		const api = new ApiClient({ requireAuth: false });
		const session = rawSession([]);
		session.messages = [{ role: "user", content: "x".repeat(50 * 1024 * 1024) }];
		const plan = planSessionUpload(session, "snapshot-v1");
		const fence = sessionFence(api, {
			environmentId: "agent-pi",
			adapter: "pi",
			sourceSessionKey: session.localSessionId,
		});
		const result = await syncSessionContent({
			api,
			fence,
			session,
			plan,
			needsSnapshotContent: true,
		});

		expect(result.status).toBe("blocked");
		expect(readFencedSessionEntry(readSessionsLock(), fence)?.blocked?.code).toBe(
			"legacy_session_too_large",
		);
	});
});

describe("events-v1 incremental upload", () => {
	it("does not mark a multi-chunk append complete before the final chunk", async () => {
		const api = eventApi();
		const content = events(["one", "a".repeat(700_000)], ["two", "b".repeat(700_000)]);
		const generation = "11111111-1111-4111-8111-111111111111";
		const finalHead = advanceEventHead(EMPTY_EVENT_HEAD, content);
		api.getSessionEventHead = async () => ({
			protocol: "events-v1",
			generation,
			revision: 1,
			count: 0,
			head_hash: EMPTY_EVENT_HEAD,
		});
		const session = rawSession(content);
		const plan = planSessionUpload(session, "events-v1");
		const fence = sessionFence(api, {
			environmentId: "agent-pi",
			adapter: "pi",
			sourceSessionKey: session.localSessionId,
		});
		let calls = 0;
		api.appendSessionEvents = async (input) => {
			calls += 1;
			if (calls === 2) {
				expect(readFencedSessionEntry(readSessionsLock(), fence)).toMatchObject({
					pending: { base_count: 1 },
				});
				expect(readFencedSessionEntry(readSessionsLock(), fence)?.event_count).toBeUndefined();
			}
			return {
				generation: input.generation,
				revision: input.baseRevision + 1,
				count: input.finalCount,
				head_hash: input.finalHeadHash,
			};
		};

		const result = await syncSessionContent({
			api,
			fence,
			session,
			plan,
			needsSnapshotContent: false,
		});

		expect(calls).toBe(2);
		expect(result).toMatchObject({ status: "synced", localHash: finalHead });
		expect(readFencedSessionEntry(readSessionsLock(), fence)).toMatchObject({
			event_count: 2,
			event_head_hash: finalHead,
			source_revision: "source-r1",
		});
	});

	it("reuses the durable append id after a retry", async () => {
		const api = eventApi();
		const content = events(["one", "first"], ["two", "second"]);
		const prefixHead = advanceEventHead(EMPTY_EVENT_HEAD, content.slice(0, 1));
		const finalHead = advanceEventHead(EMPTY_EVENT_HEAD, content);
		api.getSessionEventHead = async () => ({
			protocol: "events-v1",
			generation: "11111111-1111-4111-8111-111111111111",
			revision: 4,
			count: 1,
			head_hash: prefixHead,
		});
		const appendIds: string[] = [];
		let fail = true;
		api.appendSessionEvents = async (input) => {
			appendIds.push(input.appendId);
			if (fail) throw new Error("connection reset after request");
			return {
				generation: input.generation,
				revision: input.baseRevision + 1,
				count: input.finalCount,
				head_hash: input.finalHeadHash,
			};
		};
		const session = rawSession(content);
		const plan = planSessionUpload(session, "events-v1");
		const fence = sessionFence(api, {
			environmentId: "agent-pi",
			adapter: "pi",
			sourceSessionKey: session.localSessionId,
		});

		await expect(
			syncSessionContent({ api, fence, session, plan, needsSnapshotContent: false }),
		).rejects.toThrow("connection reset");
		const pendingAppendId = readFencedSessionEntry(readSessionsLock(), fence)?.pending?.append_id;
		if (!pendingAppendId) throw new Error("expected a durable pending append id");
		expect(pendingAppendId).toBe(appendIds[0]);

		fail = false;
		const result = await syncSessionContent({
			api,
			fence,
			session,
			plan,
			needsSnapshotContent: false,
		});
		expect(result).toMatchObject({ status: "synced", localHash: finalHead });
		expect(appendIds).toEqual([pendingAppendId, pendingAppendId]);
		expect(readFencedSessionEntry(readSessionsLock(), fence)?.pending).toBeUndefined();
	});

	it("rewrites a generation when the source is truncated", async () => {
		const api = eventApi();
		const remote = events(["old-one", "old first"], ["old-two", "old second"]);
		const replacement = events(["new-one", "rewritten"]);
		const remoteHead = advanceEventHead(EMPTY_EVENT_HEAD, remote);
		const finalHead = advanceEventHead(EMPTY_EVENT_HEAD, replacement);
		api.getSessionEventHead = async () => ({
			protocol: "events-v1",
			generation: "11111111-1111-4111-8111-111111111111",
			revision: 7,
			count: remote.length,
			head_hash: remoteHead,
		});
		let stagedGeneration = "";
		api.stageSessionEventGeneration = async (_localSessionId, body) => {
			expect(body.base_count).toBe(2);
			expect(body.base_head_hash).toBe(remoteHead);
			stagedGeneration = body.generation;
			return { generation: body.generation, status: "staging" };
		};
		api.uploadSessionEventGenerationChunk = async (input) => ({
			generation: input.generation,
			start_seq: input.startSeq,
			end_seq: input.startSeq,
			count: 1,
			content_hash: input.contentHash,
			result_head_hash: finalHead,
		});
		api.commitSessionEventGeneration = async (_localSessionId, generation, body) => ({
			generation,
			revision: body.base_revision + 1,
			count: body.final_count,
			head_hash: body.final_head_hash,
		});
		const session = rawSession(replacement);
		const plan = planSessionUpload(session, "events-v1");
		const fence = sessionFence(api, {
			environmentId: "agent-pi",
			adapter: "pi",
			sourceSessionKey: session.localSessionId,
		});

		const result = await syncSessionContent({
			api,
			fence,
			session,
			plan,
			needsSnapshotContent: false,
		});
		expect(result).toMatchObject({ status: "synced", localHash: finalHead });
		expect(readFencedSessionEntry(readSessionsLock(), fence)).toMatchObject({
			event_generation: stagedGeneration,
			event_revision: 8,
			event_count: 1,
			event_head_hash: finalHead,
		});
	});
});
