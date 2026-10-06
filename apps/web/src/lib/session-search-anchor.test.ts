import { describe, expect, test } from "bun:test";
import {
	sessionDetailLink,
	sessionDetailSearchLink,
	sessionSearchAnchorFromSearch,
	sessionTimelineCategories,
	sessionTimelineViewFromCategories,
	sessionTimelineViewLink,
	validateSessionDetailSearch,
} from "@/lib/session-search-anchor";

describe("Session search anchors", () => {
	test("builds a detail link and round-trips a complete anchor", () => {
		const link = sessionDetailLink(
			{
				id: "session-id",
				search_match: {
					role: "assistant",
					excerpt: "matching text",
					anchor: { kind: "event_seq", position: 42, revision: "events:revision" },
				},
			},
			{ returnTo: "/sessions?q=matching&page=2", searchQuery: " matching " },
		);
		expect(link).toEqual({
			to: "/sessions/$id",
			params: { id: "session-id" },
			search: {
				matchKind: "event_seq",
				matchPosition: 42,
				matchRevision: "events:revision",
				matchQuery: "matching",
				returnTo: "/sessions?q=matching&page=2",
			},
		});
		expect(sessionSearchAnchorFromSearch(validateSessionDetailSearch(link.search))).toEqual({
			kind: "event_seq",
			position: 42,
			revision: "events:revision",
		});
	});

	test("keeps a standalone query and builds a query-only detail link", () => {
		expect(
			sessionDetailSearchLink("session-id", " authentication ", {
				returnTo: "/sessions?q=authentication&page=2",
				timelineView: "assistant",
			}),
		).toEqual({
			to: "/sessions/$id",
			params: { id: "session-id" },
			search: {
				matchQuery: "authentication",
				timelineView: "assistant",
				returnTo: "/sessions?q=authentication&page=2",
			},
		});
		expect(validateSessionDetailSearch({ matchQuery: " authentication " })).toEqual({
			matchQuery: "authentication",
		});
	});

	test("keeps message search out of the tools-only timeline", () => {
		expect(validateSessionDetailSearch({ timelineView: "tools" })).toEqual({
			timelineView: "tools",
		});
		expect(validateSessionDetailSearch({ timelineView: "tools", matchQuery: " answer " })).toEqual({
			timelineView: "tools",
		});
		expect(
			validateSessionDetailSearch({
				timelineView: "tools",
				matchQuery: "answer",
				matchKind: "event_seq",
				matchPosition: 42,
				matchRevision: "events:revision",
			}),
		).toEqual({ timelineView: "tools" });
		expect(validateSessionDetailSearch({ timelineView: "unknown" })).toEqual({});
		expect(sessionTimelineViewLink("session-id", "all")).toEqual({
			to: "/sessions/$id",
			params: { id: "session-id" },
			search: { timelineView: "all" },
		});
		expect(sessionTimelineViewLink("session-id", "user,assistant")).toEqual({
			to: "/sessions/$id",
			params: { id: "session-id" },
			search: {},
		});
		expect(sessionTimelineViewLink("session-id", "assistant")).toEqual({
			to: "/sessions/$id",
			params: { id: "session-id" },
			search: { timelineView: "assistant" },
		});
		expect(sessionTimelineViewLink("session-id", "user", { searchQuery: " answer " })).toEqual({
			to: "/sessions/$id",
			params: { id: "session-id" },
			search: { matchQuery: "answer", timelineView: "user" },
		});
		expect(sessionTimelineViewLink("session-id", "tools", { searchQuery: " answer " })).toEqual({
			to: "/sessions/$id",
			params: { id: "session-id" },
			search: { timelineView: "tools" },
		});
		expect(sessionDetailSearchLink("session-id", "answer", { timelineView: "tools" })).toEqual({
			to: "/sessions/$id",
			params: { id: "session-id" },
			search: { timelineView: "tools" },
		});
	});

	test("canonicalizes composable timeline categories", () => {
		expect(validateSessionDetailSearch({ timelineView: "tools,user" })).toEqual({
			timelineView: "user,tools",
		});
		expect(
			validateSessionDetailSearch({ timelineView: "user,assistant", matchQuery: " answer " }),
		).toEqual({
			matchQuery: "answer",
		});
		expect(validateSessionDetailSearch({ timelineView: "all" })).toEqual({
			timelineView: "all",
		});
		expect(sessionTimelineCategories("all")).toEqual(["user", "assistant", "tools"]);
		expect(sessionTimelineViewFromCategories(["tools", "assistant"])).toBe("assistant,tools");
		expect(sessionTimelineViewFromCategories([])).toBeNull();
	});

	test("drops partial or malformed anchors as one unit", () => {
		expect(validateSessionDetailSearch({ matchKind: "event_seq", matchPosition: 3 })).toEqual({});
		expect(
			validateSessionDetailSearch({
				matchKind: "unknown",
				matchPosition: -1,
				matchRevision: "revision",
			}),
		).toEqual({});
	});

	test("keeps only a local Sessions collection return target", () => {
		expect(validateSessionDetailSearch({ returnTo: "/sessions?q=auth&page=3" })).toEqual({
			returnTo: "/sessions?q=auth&page=3",
		});
		expect(validateSessionDetailSearch({ returnTo: "https://example.com/sessions" })).toEqual({});
		expect(validateSessionDetailSearch({ returnTo: "/sessions/unrelated" })).toEqual({});
	});
});
