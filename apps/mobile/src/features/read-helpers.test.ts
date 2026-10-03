import { describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import {
	limitedText,
	messagePage,
	nextMessageOffset,
	nextSessionPage,
	routeParam,
	uniqueSessions,
} from "./read-helpers";

const session: components["schemas"]["SessionListItemResponse"] = {
	id: "session-a",
	local_session_id: "local-a",
	project_path: null,
	agent_type: "hermes",
	started_at: "2026-10-01T00:00:00Z",
	ended_at: null,
	updated_at: "2026-10-01T00:00:00Z",
	last_activity_at: "2026-10-01T00:00:00Z",
	duration_seconds: null,
	message_count: 2,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	model: null,
	models_used: null,
	summary: null,
	tags: null,
	status: "completed",
	content_hash: "hash-a",
	content_protocol: "events-v1",
	is_shared: false,
};
const page: components["schemas"]["SessionMessagesPage"] = {
	content_revision: "events:revision-a",
	offset: 0,
	limit: 50,
	total: 3,
	items: [{ role: "user", content: "<script>alert(1)</script>", timestamp: null }],
};

describe("read-only pagination boundaries", () => {
	test("continues by actual returned message count and stops on empty/final/unpinned pages", () => {
		expect(nextMessageOffset(page)).toBe(1);
		expect(nextMessageOffset({ ...page, items: [] })).toBeUndefined();
		expect(nextMessageOffset({ ...page, offset: 2 })).toBeUndefined();
		expect(nextMessageOffset({ ...page, content_revision: null })).toBeUndefined();
	});
	test("session pagination terminates and removes repeated ids after activity reordering", () => {
		const first = { items: [session], total: 3, page: 1, page_size: 2 };
		expect(nextSessionPage(first)).toBe(2);
		expect(nextSessionPage({ ...first, page: 2 })).toBeUndefined();
		expect(nextSessionPage({ ...first, items: [] })).toBeUndefined();
		expect(
			uniqueSessions([
				first,
				{ ...first, page: 2, items: [session, { ...session, id: "session-b" }] },
			]).map((item) => item.id),
		).toEqual(["session-a", "session-b"]);
	});
	test("preserves plain text, rejects tool projection, and bounds rendering", () => {
		expect(messagePage(page).items[0]?.content).toBe("<script>alert(1)</script>");
		expect(limitedText("123456", 4)).toBe("1234…");
		expect(limitedText("1234", 4)).toBe("1234");
		expect(() =>
			messagePage({
				...page,
				items: [
					{ kind: "tool_call", position: 1, call_id: "tool-a", name: "test", arguments_json: "{}" },
				],
			}),
		).toThrow();
	});
	test("missing and oversized route ids do not become requests", () => {
		expect(routeParam(undefined)).toBeUndefined();
		expect(routeParam([])).toBeUndefined();
		expect(routeParam(" ")).toBeUndefined();
		expect(routeParam("x".repeat(257))).toBeUndefined();
		expect(routeParam(["agent-a", "agent-b"])).toBe("agent-a");
	});
});
