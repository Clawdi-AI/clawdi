import { describe, expect, test } from "bun:test";
import {
	sessionDetailLink,
	sessionSearchAnchorFromSearch,
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
