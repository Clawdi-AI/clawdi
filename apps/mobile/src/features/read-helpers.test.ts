import { describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import {
	limitedText,
	nextSessionPage,
	projectRouteFilter,
	routeParam,
	uniqueSessions,
} from "./read-helpers";
import { adjacentTimelineCursor, timelinePage, timelineRequest } from "./timeline-state";

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
const page = {
	content_revision: "events:revision-a",
	offset: 0,
	limit: 50,
	total: 3,
	items: [
		{
			kind: "message",
			position: 17,
			role: "user",
			content: "<script>alert(1)</script>",
			timestamp: null,
		},
	],
} satisfies components["schemas"]["SessionTimelinePage"];

describe("read-only pagination boundaries", () => {
	test("explicit invalid Project scope never becomes an all-project request", () => {
		expect(projectRouteFilter(undefined)).toEqual({ kind: "all" });
		expect(projectRouteFilter("project-a")).toEqual({ kind: "project", id: "project-a" });
		for (const value of [
			"",
			" ",
			" project-a",
			"x".repeat(257),
			["project-a"],
			["project-a", "project-b"],
		])
			expect(projectRouteFilter(value)).toEqual({ kind: "invalid" });
	});
	test("continues by actual returned message count and stops on empty/final/unpinned pages", () => {
		expect(adjacentTimelineCursor(page)).toEqual({
			offset: 1,
			limit: 50,
			revision: "events:revision-a",
		});
		expect(adjacentTimelineCursor({ ...page, items: [] })).toBeUndefined();
		expect(adjacentTimelineCursor({ ...page, offset: 2 })).toBeUndefined();
		expect(adjacentTimelineCursor({ ...page, content_revision: null })).toBeUndefined();
		const previous = adjacentTimelineCursor({ ...page, offset: 17 }, true);
		expect(previous).toEqual({ offset: 0, limit: 17, revision: "events:revision-a" });
		const anchor = { kind: "event_seq", position: 80, revision: "events:revision-a" } as const;
		expect(
			timelineRequest({ offset: 0, limit: 50, initial: true }, "all", "needle", anchor),
		).toMatchObject({
			anchor_position: 80,
			search_query: "needle",
			include: ["user", "assistant", "tools"],
		});
		if (!previous) throw new Error("Expected previous cursor");
		const request = timelineRequest(previous, "all", "needle", anchor);
		expect(request?.anchor_position).toBeUndefined();
		expect(request?.search_query).toBeUndefined();
		expect(request?.content_revision).toBe("events:revision-a");
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
	test("preserves typed activity and plain text; rejects positionless content", () => {
		expect(timelinePage(page).items[0]).toMatchObject({
			content: "<script>alert(1)</script>",
			position: 17,
		});
		expect(() =>
			timelinePage({ ...page, items: [{ role: "user", content: "No source position" }] }),
		).toThrow();
		expect(limitedText("123456", 4)).toBe("1234…");
		expect(limitedText("1234", 4)).toBe("1234");
		expect(
			timelinePage({
				...page,
				items: [
					{ kind: "tool_call", position: 1, call_id: "tool-a", name: "test", arguments_json: "{}" },
				],
			}).items[0],
		).toMatchObject({ kind: "tool_call", position: 1, call_id: "tool-a" });
	});
	test("missing and oversized route ids do not become requests", () => {
		expect(routeParam(undefined)).toBeUndefined();
		expect(routeParam([])).toBeUndefined();
		expect(routeParam(" ")).toBeUndefined();
		expect(routeParam("x".repeat(257))).toBeUndefined();
		expect(routeParam(["agent-a", "agent-b"])).toBe("agent-a");
	});
});
