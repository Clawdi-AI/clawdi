import { describe, expect, test } from "bun:test";
import { isSearchQueryReady, SEARCH_QUERY_MAX_LENGTH, searchQueryLength } from "./search-query";

describe("remote search query contract", () => {
	test("counts trimmed Unicode code points", () => {
		expect(searchQueryLength("  x  ")).toBe(1);
		expect(searchQueryLength("😀")).toBe(1);
		expect(isSearchQueryReady("中文")).toBeTrue();
		expect(isSearchQueryReady("x")).toBeFalse();
		expect(isSearchQueryReady("x".repeat(SEARCH_QUERY_MAX_LENGTH + 1))).toBeFalse();
	});
});
