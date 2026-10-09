import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawSession, SessionEvent } from "../adapters/base";
import { PiAdapter } from "../adapters/pi";
import { SESSION_PROJECTION_REVISION, visibleContentParts } from "../adapters/rich-event-mapping";
import { ApiClient, ApiError } from "./api-client";
import {
	advanceEventHead,
	EMPTY_EVENT_HEAD,
	encodeEventNdjson,
	projectEventsToMessages,
	sequenceSessionEvents,
} from "./session-events";
import {
	negotiateSessionProtocol,
	planSessionUpload,
	prepareSessionUpload,
	SessionPlanStaleError,
	sessionFence,
	sessionPlanIsDurablyBlocked,
	syncSessionContent,
} from "./session-upload";
import {
	isSessionBlockCurrent,
	persistFencedSessionEntry,
	readFencedSessionEntry,
	readSessionsLock,
} from "./sessions-lock";
import { getCliVersion } from "./version";

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

function rawSession(content: readonly SessionEvent[], streamed = false): RawSession {
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
		messages: streamed ? [] : projectEventsToMessages(content),
		...(streamed
			? {
					readEvents: async function* () {
						yield* content;
					},
				}
			: { events: [...content] }),
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
	it.each([
		["current", getCliVersion(), 0, true],
		["previous CLI", "old-version", 0, false],
		["expired", getCliVersion(), -24 * 60 * 60 * 1000 - 1, false],
		["future", getCliVersion(), 1, false],
		["legacy", undefined, 0, false],
		["invalid date", getCliVersion(), NaN, false],
	] as const)("checks %s blocks", (_name, version, offset, current) => {
		const now = Date.now();
		expect(
			isSessionBlockCurrent(
				{
					code: "event_schema_invalid",
					content_hash: "hash",
					message: "rejected",
					blocked_at: Number.isNaN(offset) ? "invalid" : new Date(now + offset).toISOString(),
					cli_version: version,
				},
				now,
			),
		).toBe(current);
	});

	it("plans snapshots without retaining bodies and verifies content when materialized", async () => {
		let text = "original";
		const session = rawSession([]);
		session.readEvents = async function* () {
			yield event("snapshot", text);
		};
		const plan = await prepareSessionUpload(session, "snapshot-v1");
		expect(plan.snapshotBytes).toBeUndefined();
		expect(plan.readSnapshot).toBeDefined();
		const bytes = await plan.readSnapshot?.();
		expect(bytes?.toString()).toBe(
			JSON.stringify(projectEventsToMessages([event("snapshot", text)])),
		);
		text = "changed";
		await expect(plan.readSnapshot?.()).rejects.toThrow("snapshot source changed");
	});
	it("uses a supplied scan snapshot while default blocked reads stay fresh", () => {
		const session = rawSession([event("snapshot", "content")]);
		const plan = planSessionUpload(session, "events-v1");
		const fence = sessionFence(new ApiClient({ requireAuth: false }), {
			environmentId: "agent-pi",
			adapter: "pi",
			sourceSessionKey: session.localSessionId,
		});
		const entry = { protocol: plan.protocol, local_hash: plan.localHash };
		persistFencedSessionEntry(fence, entry);
		const snapshot = readSessionsLock();
		persistFencedSessionEntry(fence, {
			...entry,
			blocked: {
				code: "event_too_large",
				content_hash: plan.localHash,
				size_bytes: 100,
				message: "blocked after snapshot",
				blocked_at: new Date().toISOString(),
				cli_version: getCliVersion(),
			},
		});
		expect(sessionPlanIsDurablyBlocked(fence, plan, snapshot)).toBeNull();
		expect(sessionPlanIsDurablyBlocked(fence, plan)).toBe("blocked after snapshot");
		expect(sessionPlanIsDurablyBlocked({ ...fence, environmentId: "other" }, plan)).toBeNull();
		expect(sessionPlanIsDurablyBlocked(fence, { ...plan, localHash: "different" })).toBeNull();
		persistFencedSessionEntry(fence, entry);
		expect(sessionPlanIsDurablyBlocked(fence, plan)).toBeNull();
	});

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
	it.each([undefined, false, true] as const)(
		"confirms shortening a remote prefix (confirmed=%s)",
		async (confirmed) => {
			const api = eventApi();
			const remote = events(["one", "first"], ["two", "second"], ["three", "third"]);
			const session = rawSession(remote.slice(0, 2));
			const plan = planSessionUpload(session, "events-v1");
			const fence = sessionFence(api, {
				environmentId: "agent-pi",
				adapter: "pi",
				sourceSessionKey: session.localSessionId,
			});
			api.getSessionEventHead = async () => ({
				protocol: "events-v1",
				generation: "remote",
				revision: 7,
				count: 3,
				head_hash: advanceEventHead(EMPTY_EVENT_HEAD, remote),
			});
			let confirmations = 0;
			let stages = 0;
			let commits = 0;
			api.stageSessionEventGeneration = async (_id, body) => {
				stages++;
				if (stages === 1) throw new ApiError({ status: 409, body: "retry", hint: "conflict" });
				return { generation: body.generation, status: "staging" };
			};
			api.uploadSessionEventGenerationChunk = async (chunk) => ({
				generation: chunk.generation,
				start_seq: chunk.startSeq,
				end_seq: 1,
				count: 2,
				content_hash: chunk.contentHash,
				result_head_hash: plan.localHash,
			});
			api.commitSessionEventGeneration = async (_id, generation, body) => {
				commits++;
				return {
					generation,
					revision: body.base_revision + 1,
					count: body.final_count,
					head_hash: body.final_head_hash,
				};
			};
			const input = {
				api,
				fence,
				session,
				plan,
				needsSnapshotContent: false,
				...(confirmed === undefined
					? {}
					: {
							confirmPlanCurrent: async () => {
								confirmations++;
								return confirmed;
							},
						}),
			};
			if (confirmed === true) {
				expect((await syncSessionContent(input)).status).toBe("synced");
				expect({ confirmations, stages, commits }).toEqual({
					confirmations: 1,
					stages: 2,
					commits: 1,
				});
			} else {
				await expect(syncSessionContent(input)).rejects.toBeInstanceOf(SessionPlanStaleError);
				expect({ confirmations, stages, commits }).toEqual({
					confirmations: confirmed === undefined ? 0 : 1,
					stages: 0,
					commits: 0,
				});
				expect(readFencedSessionEntry(readSessionsLock(), fence)).toBeUndefined();
			}
		},
	);

	it.each(["stage", "commit"] as const)("does not block a %s 422", async (operation) => {
		const api = eventApi();
		const session = rawSession(events(["one", "first"]));
		const plan = planSessionUpload(session, "events-v1");
		const fence = sessionFence(api, {
			environmentId: "agent-pi",
			adapter: "pi",
			sourceSessionKey: session.localSessionId,
		});
		api.getSessionEventHead = async () => ({
			protocol: "events-v1",
			generation: null,
			revision: 0,
			count: 0,
			head_hash: EMPTY_EVENT_HEAD,
		});
		const reject = async () => {
			throw new ApiError({ status: 422, body: "invalid generation", hint: "validation" });
		};
		api.stageSessionEventGeneration =
			operation === "stage"
				? reject
				: async (_id, body) => ({ generation: body.generation, status: "committed" });
		api.commitSessionEventGeneration = reject;
		await expect(
			syncSessionContent({ api, fence, session, plan, needsSnapshotContent: false }),
		).rejects.toThrow("API error 422: validation");
		expect(readFencedSessionEntry(readSessionsLock(), fence)?.blocked).toBeUndefined();
	});

	it.each(["append", "rewrite"] as const)(
		"persists a %s validation rejection, skips unchanged content and recovers after re-mapping",
		async (kind) => {
			const api = eventApi();
			const generation = "11111111-1111-4111-8111-111111111111";
			const session = rawSession(events(["one", "first"], ["two", "before fix"]), true);
			const fence = sessionFence(api, {
				environmentId: "agent-pi",
				adapter: "pi",
				sourceSessionKey: session.localSessionId,
			});
			const plan = await prepareSessionUpload(session, "events-v1");
			let reads = 0;
			let uploads = 0;
			api.getSessionEventHead = async () => {
				reads++;
				return {
					protocol: "events-v1",
					generation: kind === "append" ? generation : null,
					revision: 0,
					count: 0,
					head_hash: EMPTY_EVENT_HEAD,
				};
			};
			api.stageSessionEventGeneration = async (_id, body) => ({
				generation: body.generation,
				status: "staging",
			});
			const reject = async () => {
				uploads++;
				throw new ApiError({
					status: 422,
					body: '{"detail":"event does not match events-v1 at seq 1: message.parts.1.attachment.name (string_too_long)"}',
					hint: "validation failed",
				});
			};
			api.appendSessionEvents = reject;
			api.uploadSessionEventGenerationChunk = reject;
			const input = { api, fence, session, plan, needsSnapshotContent: false };
			const result = await syncSessionContent(input);
			expect(result.status).toBe("blocked");
			expect(readFencedSessionEntry(readSessionsLock(), fence)).toMatchObject({
				local_hash: plan.localHash,
				blocked: { code: "event_schema_invalid", content_hash: plan.localHash },
			});
			expect(readFencedSessionEntry(readSessionsLock(), fence)?.event_head_hash).toBeUndefined();
			// A fresh lock read represents the next daemon cycle or process restart.
			expect(sessionPlanIsDurablyBlocked(fence, plan)).toContain("validation failed");
			expect(await syncSessionContent(input)).toEqual(result);
			expect({ reads, uploads }).toEqual({ reads: 1, uploads: 1 });
			const fixed = rawSession(events(["one", "first"], ["two", "after fix"]), true);
			const fixedPlan = await prepareSessionUpload(fixed, "events-v1");
			expect(sessionPlanIsDurablyBlocked(fence, fixedPlan)).toBeNull();
			api.getSessionEventHead = async () => ({
				protocol: "events-v1",
				generation,
				revision: 1,
				count: 0,
				head_hash: EMPTY_EVENT_HEAD,
			});
			api.appendSessionEvents = async (chunk) => {
				const rows = chunk.file
					.toString()
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(rows.map((row) => row.parts[0].text)).toEqual(["first", "after fix"]);
				return {
					generation,
					revision: 2,
					count: fixedPlan.eventCount ?? 0,
					head_hash: fixedPlan.localHash,
				};
			};
			expect((await syncSessionContent({ ...input, session: fixed, plan: fixedPlan })).status).toBe(
				"synced",
			);
			expect(readFencedSessionEntry(readSessionsLock(), fence)?.blocked).toBeUndefined();
		},
	);
	it("re-uploads a rejected attachment after a CLI upgrade without changing its source revision", async () => {
		const api = eventApi();
		const inputAttachment = {
			type: "file",
			id: "attachment",
			name: `${"a".repeat(600)}.pdf`,
			size: 42,
			sha256: "a".repeat(64),
		};
		const fixedEvents = sequenceSessionEvents([
			{
				type: "message",
				role: "user",
				source: { adapter: "codex", session_key: "fixture", record_id: "attachment" },
				parts: visibleContentParts(inputAttachment),
			},
		]);
		const oldEvents: SessionEvent[] = fixedEvents.map((event) =>
			event.type === "message"
				? {
						...event,
						parts: event.parts.map((part) =>
							part.type === "attachment" ? { ...part, name: inputAttachment.name } : part,
						),
					}
				: event,
		);
		const oldSession = rawSession(oldEvents, true);
		oldSession.sourceRevision = `jsonl-stat-v1:p${SESSION_PROJECTION_REVISION}:42:1024:1000000000:1000000000`;
		const oldPlan = await prepareSessionUpload(oldSession, "events-v1");
		const fence = sessionFence(api, {
			environmentId: "agent-codex",
			adapter: "codex",
			sourceSessionKey: oldSession.localSessionId,
		});
		api.getSessionEventHead = async () => ({
			protocol: "events-v1",
			generation: null,
			revision: 0,
			count: 0,
			head_hash: EMPTY_EVENT_HEAD,
		});
		const staged: string[] = [];
		api.stageSessionEventGeneration = async (_id, body) => {
			staged.push(body.generation);
			return { generation: body.generation, status: "staging" };
		};
		api.uploadSessionEventGenerationChunk = async () => {
			throw new ApiError({
				status: 422,
				body: '{"detail":"event does not match events-v1 at seq 0: message.parts.0.attachment.name (string_too_long)"}',
				hint: "validation failed",
			});
		};
		expect(
			(
				await syncSessionContent({
					api,
					fence,
					session: oldSession,
					plan: oldPlan,
					needsSnapshotContent: false,
				})
			).status,
		).toBe("blocked");
		const rejected = readFencedSessionEntry(readSessionsLock(), fence);
		if (!rejected?.blocked) throw new Error("expected persisted attachment rejection");
		expect(rejected.blocked.code).toBe("event_schema_invalid");
		expect(rejected.source_revision).toBe(oldSession.sourceRevision);
		expect(sessionPlanIsDurablyBlocked(fence, oldPlan)).toContain("validation failed");
		// Upgrade invalidates the block even when the source and projection revision
		// are unchanged. The next upload reads the source through the new mapper.
		persistFencedSessionEntry(fence, {
			...rejected,
			blocked: { ...rejected.blocked, cli_version: "before-upgrade" },
		});
		expect(sessionPlanIsDurablyBlocked(fence, oldPlan)).toBeNull();
		const fixedSession = rawSession(fixedEvents, true);
		fixedSession.sourceRevision = oldSession.sourceRevision;
		const fixedPlan = await prepareSessionUpload(fixedSession, "events-v1");
		expect(fixedPlan.localHash).not.toBe(oldPlan.localHash);
		expect(sessionPlanIsDurablyBlocked(fence, fixedPlan)).toBeNull();
		const uploaded: Buffer[] = [];
		api.uploadSessionEventGenerationChunk = async (chunk) => {
			uploaded.push(chunk.file);
			return {
				generation: chunk.generation,
				start_seq: chunk.startSeq,
				end_seq: chunk.startSeq,
				count: 1,
				content_hash: chunk.contentHash,
				result_head_hash: fixedPlan.finalEventHead ?? "",
			};
		};
		api.commitSessionEventGeneration = async (_id, generation, body) => ({
			generation,
			revision: 1,
			count: body.final_count,
			head_hash: body.final_head_hash,
		});
		expect(
			(
				await syncSessionContent({
					api,
					fence,
					session: fixedSession,
					plan: fixedPlan,
					needsSnapshotContent: false,
				})
			).status,
		).toBe("synced");
		expect(uploaded).toHaveLength(1);
		expect(uploaded[0]?.toString("ascii")).toBe(encodeEventNdjson(fixedEvents).toString("ascii"));
		expect(staged).toHaveLength(2);
		expect(staged[1]).not.toBe(staged[0]);
		expect(readFencedSessionEntry(readSessionsLock(), fence)?.blocked).toBeUndefined();
		expect(readFencedSessionEntry(readSessionsLock(), fence)?.source_revision).toBe(
			oldSession.sourceRevision,
		);
	});

	it.each([-1, 0, 1])(
		"preserves canonical Unicode bytes at chunk budget boundary %i",
		async (boundary) => {
			const api = eventApi();
			const first = event("one", "中文😀\ud800\n");
			const content = [first, { ...first, seq: 1 }];
			// Python json.dumps(ensure_ascii=True, sort_keys=True, separators=(",", ":")) golden.
			const firstLine =
				String.raw`{"event_id":"08e6ec3d75bc565a77dac73f766e3e985424d16fbb24077be436e230f09b3527","parts":[{"text":"\u4e2d\u6587\ud83d\ude00\ud800\n","type":"text"}],"role":"assistant","seq":0,"source":{"adapter":"pi","record_id":"one","session_key":"fixture"},"type":"message"}` +
				"\n";
			const secondLine = firstLine.replace('"seq":0', '"seq":1');
			const finalHead = "c27463ce4d853bf824e5016c5a9393fa61ca18775e0aef99ea29cca185cab1c4";
			const maxBytes = boundary === 1 ? firstLine.length * 2 : firstLine.length + boundary;
			api.getSessionUploadCapabilities = async () => ({
				protocols: ["events-v1"],
				event_chunk_target_bytes: 1024 * 1024,
				event_chunk_max_bytes: maxBytes,
			});
			api.getSessionEventHead = async () => ({
				protocol: "events-v1",
				generation: "11111111-1111-4111-8111-111111111111",
				revision: 1,
				count: 0,
				head_hash: EMPTY_EVENT_HEAD,
			});
			const uploaded: Buffer[] = [];
			api.appendSessionEvents = async (input) => {
				uploaded.push(input.file);
				expect(input.file.length).toBeLessThanOrEqual(maxBytes);
				return {
					generation: input.generation,
					revision: input.baseRevision + 1,
					count: input.finalCount,
					head_hash: advanceEventHead(EMPTY_EVENT_HEAD, content.slice(0, input.finalCount)),
				};
			};
			const session = rawSession(content);
			const plan = planSessionUpload(session, "events-v1");
			expect(plan.finalEventHead).toBe(finalHead);
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
			const entry = readFencedSessionEntry(readSessionsLock(), fence);
			if (boundary === -1) {
				expect(result.status).toBe("blocked");
				expect(uploaded).toHaveLength(0);
				expect(entry?.blocked).toMatchObject({
					code: "event_too_large",
					size_bytes: firstLine.length,
				});
			} else {
				expect(result.status).toBe("synced");
				expect(uploaded).toHaveLength(boundary === 0 ? 2 : 1);
				expect(Buffer.concat(uploaded).equals(Buffer.from(firstLine + secondLine, "ascii"))).toBe(
					true,
				);
				expect(entry?.event_head_hash).toBe(finalHead);
			}
		},
	);

	it.each([false, true])(
		"does not mark a multi-chunk append complete before the final chunk (streamed=%s)",
		async (streamed) => {
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
			const session = rawSession(content, streamed);
			const plan = await prepareSessionUpload(session, "events-v1");
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
		},
	);

	it.each([false, true])(
		"reuses the durable append id after a conflict and transport retry (streamed=%s)",
		async (streamed) => {
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
				if (appendIds.length === 1) {
					throw new ApiError({ status: 409, body: "conflict", hint: "retry" });
				}
				if (fail) throw new Error("connection reset after request");
				return {
					generation: input.generation,
					revision: input.baseRevision + 1,
					count: input.finalCount,
					head_hash: input.finalHeadHash,
				};
			};
			const session = rawSession(content, streamed);
			const plan = await prepareSessionUpload(session, "events-v1");
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
			expect(appendIds).toEqual([pendingAppendId, pendingAppendId, pendingAppendId]);
			expect(readFencedSessionEntry(readSessionsLock(), fence)?.pending).toBeUndefined();
		},
	);

	it.each([false, true])(
		"rejects a mismatched rewrite receipt and resumes the staged generation (streamed=%s)",
		async (streamed) => {
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
			let corruptReceipt = true;
			api.uploadSessionEventGenerationChunk = async (input) => ({
				generation: input.generation,
				start_seq: input.startSeq,
				end_seq: input.startSeq,
				count: 1,
				content_hash: input.contentHash,
				result_head_hash: corruptReceipt ? "f".repeat(64) : finalHead,
			});
			api.commitSessionEventGeneration = async (_localSessionId, generation, body) => ({
				generation,
				revision: body.base_revision + 1,
				count: body.final_count,
				head_hash: body.final_head_hash,
			});
			const session = rawSession(replacement, streamed);
			const plan = await prepareSessionUpload(session, "events-v1");
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
					needsSnapshotContent: false,
					confirmPlanCurrent: async () => true,
				}),
			).rejects.toThrow("server event chunk receipt does not match uploaded bytes");
			const pendingGeneration = readFencedSessionEntry(readSessionsLock(), fence)?.pending
				?.generation;
			if (!pendingGeneration) throw new Error("expected a durable pending generation");
			expect(pendingGeneration).toBe(stagedGeneration);
			expect(readFencedSessionEntry(readSessionsLock(), fence)?.event_head_hash).toBeUndefined();
			corruptReceipt = false;

			const result = await syncSessionContent({
				api,
				fence,
				session,
				plan,
				needsSnapshotContent: false,
				confirmPlanCurrent: async () => true,
			});
			expect(stagedGeneration).toBe(pendingGeneration);
			expect(result).toMatchObject({ status: "synced", localHash: finalHead });
			expect(readFencedSessionEntry(readSessionsLock(), fence)).toMatchObject({
				event_generation: stagedGeneration,
				event_revision: 8,
				event_count: 1,
				event_head_hash: finalHead,
			});
		},
	);
});

it.each([
	["stage", false],
	["chunk", false],
	["commit", false],
	["stage", true],
	["chunk", true],
	["commit", true],
] as const)("restarts an expired staged upload at %s (streamed=%s)", async (expireAt, streamed) => {
	const api = eventApi();
	const session = rawSession(events(["one", "hello"]), streamed);
	const plan = await prepareSessionUpload(session, "events-v1");
	const fence = sessionFence(api, {
		environmentId: "agent-pi",
		adapter: "pi",
		sourceSessionKey: session.localSessionId,
	});
	api.getSessionEventHead = async () => ({
		protocol: "events-v1",
		generation: null,
		revision: 0,
		count: 0,
		head_hash: EMPTY_EVENT_HEAD,
	});
	let interrupted = true;
	let expired = false;
	const stages: Array<{ generation: string; appendId: string }> = [];
	const expire = () => {
		expired = true;
		throw new ApiError({ status: 410, body: "session_event_staging_expired", hint: "" });
	};
	api.stageSessionEventGeneration = async (_id, body) => {
		stages.push({ generation: body.generation, appendId: body.append_id });
		if (!interrupted && expireAt === "stage" && !expired) expire();
		return { generation: body.generation, status: "staging" };
	};
	api.uploadSessionEventGenerationChunk = async (input) => {
		if (interrupted) {
			interrupted = false;
			throw new ApiError({ status: 503, body: "interrupted upload", hint: "" });
		}
		if (expireAt === "chunk" && !expired) expire();
		return {
			generation: input.generation,
			start_seq: input.startSeq,
			end_seq: input.startSeq,
			count: 1,
			content_hash: input.contentHash,
			result_head_hash: plan.localHash,
		};
	};
	api.commitSessionEventGeneration = async (_id, generation, body) => {
		if (expireAt === "commit" && !expired) expire();
		return {
			generation,
			revision: body.base_revision + 1,
			count: body.final_count,
			head_hash: body.final_head_hash,
		};
	};
	const input = { api, fence, session, plan, needsSnapshotContent: false };
	await expect(syncSessionContent(input)).rejects.toThrow("API error 503: Service unavailable");
	const pending = readFencedSessionEntry(readSessionsLock(), fence)?.pending;
	if (!pending) throw new Error("expected durable staged upload");
	const result = await syncSessionContent(input);
	const fresh = stages[2];
	if (!fresh) throw new Error("expected fresh generation after expiry");
	expect(stages).toHaveLength(3);
	expect(stages[1]?.generation).toBe(pending.generation);
	expect(fresh.generation).not.toBe(pending.generation);
	expect(fresh.appendId).not.toBe(pending.append_id);
	expect(result.status).toBe("synced");
	const receipt = readFencedSessionEntry(readSessionsLock(), fence);
	expect(receipt?.event_generation).toBe(fresh.generation);
	expect(receipt?.pending).toBeUndefined();
});
