import { describe, expect, it } from "bun:test";
import { sessionDetailQueryKey } from "@clawdi/shared/view";
import { normalizeSessionListQuery } from "../api/session-query";

describe("session query cache keys", () => {
	it("fills backend defaults so equivalent list queries share cache", () => {
		expect(normalizeSessionListQuery({})).toEqual({
			page: 1,
			page_size: 25,
			sort: "last_activity_at",
			order: "desc",
		});
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

	it("keeps the default profile key as an explicit filter", () => {
		expect(normalizeSessionListQuery({ profile_key: "" })).toMatchObject({ profile_key: "" });
		expect(normalizeSessionListQuery({ profile_key: null })).not.toHaveProperty("profile_key");
	});

	it("sorts unordered array filters for stable keys", () => {
		expect(normalizeSessionListQuery({ tag: ["beta", "alpha"], model: ["z", "a"] })).toMatchObject({
			model: ["a", "z"],
			tag: ["alpha", "beta"],
		});
	});

	it("uses the OpenAPI detail key consumed by session pages", () => {
		expect(sessionDetailQueryKey("session_1")).toEqual([
			"get",
			"/v1/sessions/{session_id}",
			{ params: { path: { session_id: "session_1" } } },
		]);
	});
});
