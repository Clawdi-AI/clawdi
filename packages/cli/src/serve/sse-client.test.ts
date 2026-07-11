/**
 * SSE record-parser unit tests.
 *
 * The wire format is fragile — extra spaces, comment lines, and
 * multi-line `data:` payloads each have a spec-mandated handling
 * that's easy to get wrong. These tests pin the behavior so a
 * future refactor can't silently start dropping events.
 *
 * Full daemon stream behavior (long reconnect storms, stale-silence
 * timer, 401 shutdown) is exercised against a real backend. The small
 * reconnect-metadata unit tests below pin the CLI-side classification
 * contract without needing a long-running daemon fixture.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { classifySseReconnect, consumeSse, parseRecord } from "./sse-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("classifySseReconnect", () => {
	it("treats the first few reconnects as transient churn", () => {
		expect(classifySseReconnect(1)).toBe("transient");
		expect(classifySseReconnect(2)).toBe("transient");
		expect(classifySseReconnect(3)).toBe("transient");
	});

	it("promotes repeated reconnects to a sustained failure", () => {
		expect(classifySseReconnect(4)).toBe("sustained");
	});
});

describe("consumeSse reconnect metadata", () => {
	it("reports request ids and transient classification for HTTP reconnects", async () => {
		const fakeFetch: typeof fetch = Object.assign(
			async () =>
				new Response("bad gateway", {
					status: 502,
					headers: { "x-request-id": "req-sse-502" },
				}),
			{
				preconnect: originalFetch.preconnect,
			},
		);
		globalThis.fetch = fakeFetch;
		const abort = new AbortController();
		const disconnects: unknown[] = [];

		await consumeSse({
			apiUrl: "https://cloud.example",
			apiKey: "test-key",
			abort: abort.signal,
			onEvent: () => {},
			onDisconnect: (info) => {
				disconnects.push(info);
				abort.abort();
			},
		});

		expect(disconnects).toEqual([
			{
				reason: "http_502",
				attempt: 0,
				wait_ms: expect.any(Number),
				consecutive_failures: 1,
				classification: "transient",
				http_status: 502,
				request_id: "req-sse-502",
			},
		]);
	});

	it("starts unstable close failure counts at one", async () => {
		const fakeFetch: typeof fetch = Object.assign(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.close();
						},
					}),
					{ status: 200 },
				),
			{
				preconnect: originalFetch.preconnect,
			},
		);
		globalThis.fetch = fakeFetch;
		const abort = new AbortController();
		const disconnects: unknown[] = [];

		await consumeSse({
			apiUrl: "https://cloud.example",
			apiKey: "test-key",
			abort: abort.signal,
			onEvent: () => {},
			onDisconnect: (info) => {
				disconnects.push(info);
				abort.abort();
			},
		});

		expect(disconnects).toEqual([
			{
				reason: "unstable_close",
				attempt: 0,
				wait_ms: expect.any(Number),
				consecutive_failures: 1,
				classification: "transient",
				first_byte_received: false,
			},
		]);
	});
});

describe("parseRecord", () => {
	it("parses a well-formed skill_changed record", () => {
		const record =
			'event: skill_changed\ndata: {"type":"skill_changed","skill_key":"hello","project_id":"00000000-0000-0000-0000-000000000001","skills_revision":7}';
		const parsed = parseRecord(record);
		expect(parsed).toEqual({
			type: "skill_changed",
			skill_key: "hello",
			project_id: "00000000-0000-0000-0000-000000000001",
			skills_revision: 7,
		});
	});

	it("parses runtime manifest change signals", () => {
		const record =
			'event: runtime_manifest_changed\ndata: {"type":"runtime_manifest_changed","environment_id":"env-runtime-1"}';
		expect(parseRecord(record)).toEqual({
			type: "runtime_manifest_changed",
			environment_id: "env-runtime-1",
		});
	});

	it("rejects malformed runtime manifest change signals", () => {
		const record =
			'event: runtime_manifest_changed\ndata: {"type":"runtime_manifest_changed","environment_id":""}';
		expect(parseRecord(record)).toBeNull();
	});

	it("ignores leading colon-comment lines (heartbeats)", () => {
		// `: ping` is the SSE heartbeat the server emits every 25s.
		// Mixed with a real event in the same record, the comment
		// must be stripped without affecting the event.
		const record =
			': ping\nevent: skill_changed\ndata: {"type":"skill_changed","skill_key":"a","project_id":"00000000-0000-0000-0000-000000000001","skills_revision":1}';
		const parsed = parseRecord(record);
		expect(parsed).toEqual(expect.objectContaining({ skill_key: "a" }));
	});

	it("strips a single optional space after the field colon", () => {
		// SSE spec: a value of "hi" can be written as `data:hi` OR
		// `data: hi`. The space is part of the framing, not the
		// payload. A regression here would prepend a space to
		// every event's JSON and break the parse.
		const record = `event:skill_changed\ndata:{"type":"skill_changed","skill_key":"x","project_id":"00000000-0000-0000-0000-000000000001","skills_revision":1}`;
		const parsed = parseRecord(record);
		expect(parsed).toEqual(expect.objectContaining({ skill_key: "x" }));
	});

	it("concatenates multi-line data fields with newline", () => {
		// SSE allows `data:` to repeat in one record; the spec
		// glues the values with `\n`. Our payloads are single-line
		// JSON so this rarely fires in practice, but the parser
		// has to honor it or a future server change breaks us.
		const record =
			'event: skill_changed\ndata: {"type":"skill_changed",\ndata: "skill_key":"multi","project_id":"00000000-0000-0000-0000-000000000001","skills_revision":2}';
		const parsed = parseRecord(record);
		expect(parsed).toEqual(expect.objectContaining({ skill_key: "multi" }));
	});

	it("returns null for a record with no data field", () => {
		const record = "event: skill_changed";
		expect(parseRecord(record)).toBeNull();
	});

	it("returns null for a record with no event field", () => {
		// Pure data without an event header is treated as a
		// no-op heartbeat-style line — we only act on named events.
		const record = 'data: {"type":"skill_changed"}';
		expect(parseRecord(record)).toBeNull();
	});

	it("returns null on malformed JSON in data", () => {
		const record = "event: skill_changed\ndata: not-json";
		expect(parseRecord(record)).toBeNull();
	});

	it("logs but still returns the parsed event when type field disagrees with header", () => {
		// If the server's `event:` header says one thing and the
		// JSON payload's `type` says another, we trust the JSON
		// (the field the consumer actually switches on) and just
		// warn. Helps catch a server-side regression without
		// breaking the channel.
		const record =
			'event: skill_changed\ndata: {"type":"skill_deleted","skill_key":"x","project_id":"00000000-0000-0000-0000-000000000001","skills_revision":1}';
		const parsed = parseRecord(record);
		expect(parsed?.type).toBe("skill_deleted");
	});
});
