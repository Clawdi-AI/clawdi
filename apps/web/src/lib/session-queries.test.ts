import { describe, expect, it } from "bun:test";
import { normalizeSessionListQuery, sessionListQueryKey } from "./session-queries";

describe("session query cache keys", () => {
	it("fills backend defaults so equivalent list queries share cache", () => {
		expect(normalizeSessionListQuery({})).toEqual({
			page: 1,
			page_size: 25,
			sort: "last_activity_at",
			order: "desc",
		});
		expect(sessionListQueryKey({})).toEqual(
			sessionListQueryKey({
				page: 1,
				page_size: 25,
				sort: "last_activity_at",
				order: "desc",
			}),
		);
	});

	it("drops empty filters while preserving explicit false filters", () => {
		expect(
			normalizeSessionListQuery({
				q: "",
				agent: " ",
				has_pr: null,
				automated: false,
			}),
		).toEqual({
			page: 1,
			page_size: 25,
			sort: "last_activity_at",
			order: "desc",
			automated: false,
		});
	});

	it("sorts unordered array filters for stable keys", () => {
		expect(normalizeSessionListQuery({ tag: ["beta", "alpha"], model: ["z", "a"] })).toMatchObject({
			model: ["a", "z"],
			tag: ["alpha", "beta"],
		});
	});
});
