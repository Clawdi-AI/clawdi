import { describe, expect, test } from "bun:test";
import {
	sessionDetailLink,
	sessionSearchAnchorFromSearch,
	validateSessionDetailSearch,
} from "@/lib/session-search-anchor";

describe("Session search anchors", () => {
	test("builds a detail link and round-trips a complete anchor", () => {
		const link = sessionDetailLink({
			id: "session-id",
			search_match: {
				role: "assistant",
				excerpt: "matching text",
				anchor: { kind: "event_seq", position: 42, revision: "events:revision" },
			},
		});
		expect(link).toEqual({
			to: "/sessions/$id",
			params: { id: "session-id" },
			search: {
				matchKind: "event_seq",
				matchPosition: 42,
				matchRevision: "events:revision",
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
});
