/**
 * SSE record-parser unit tests.
 *
 * The wire format is fragile — extra spaces, comment lines, and
 * multi-line `data:` payloads each have a spec-mandated handling
 * that's easy to get wrong. These tests pin the behavior so a
 * future refactor can't silently start dropping events.
 *
 * End-to-end stream behavior (reconnect backoff, stale-silence
 * timer, 401 handling) is exercised by the daemon against a real
 * backend and not unit-tested here — too much asyncio plumbing.
 */

import { describe, expect, it } from "bun:test";
import { parseRecord } from "./sse-client";

describe("parseRecord", () => {
	it("parses a well-formed skill_changed record", () => {
		const record =
			'event: skill_changed\ndata: {"type":"skill_changed","skill_key":"hello","scope_id":"00000000-0000-0000-0000-000000000001","skills_revision":7}';
		const parsed = parseRecord(record);
		expect(parsed).toEqual({
			type: "skill_changed",
			skill_key: "hello",
			scope_id: "00000000-0000-0000-0000-000000000001",
			skills_revision: 7,
		});
	});

	it("ignores leading colon-comment lines (heartbeats)", () => {
		// `: ping` is the SSE heartbeat the server emits every 25s.
		// Mixed with a real event in the same record, the comment
		// must be stripped without affecting the event.
		const record =
			': ping\nevent: skill_changed\ndata: {"type":"skill_changed","skill_key":"a","scope_id":"00000000-0000-0000-0000-000000000001","skills_revision":1}';
		const parsed = parseRecord(record);
		expect(parsed?.skill_key).toBe("a");
	});

	it("strips a single optional space after the field colon", () => {
		// SSE spec: a value of "hi" can be written as `data:hi` OR
		// `data: hi`. The space is part of the framing, not the
		// payload. A regression here would prepend a space to
		// every event's JSON and break the parse.
		const record = `event:skill_changed\ndata:{"type":"skill_changed","skill_key":"x","scope_id":"00000000-0000-0000-0000-000000000001","skills_revision":1}`;
		const parsed = parseRecord(record);
		expect(parsed?.skill_key).toBe("x");
	});

	it("concatenates multi-line data fields with newline", () => {
		// SSE allows `data:` to repeat in one record; the spec
		// glues the values with `\n`. Our payloads are single-line
		// JSON so this rarely fires in practice, but the parser
		// has to honor it or a future server change breaks us.
		const record =
			'event: skill_changed\ndata: {"type":"skill_changed",\ndata: "skill_key":"multi","scope_id":"00000000-0000-0000-0000-000000000001","skills_revision":2}';
		const parsed = parseRecord(record);
		expect(parsed?.skill_key).toBe("multi");
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
			'event: skill_changed\ndata: {"type":"skill_deleted","skill_key":"x","scope_id":"00000000-0000-0000-0000-000000000001","skills_revision":1}';
		const parsed = parseRecord(record);
		expect(parsed?.type).toBe("skill_deleted");
	});
});
