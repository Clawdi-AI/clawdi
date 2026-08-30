import { describe, expect, test } from "bun:test";
import { literalSearchRank, searchExcerpt, splitSearchHighlight } from "@/lib/search-highlight";

describe("search highlighting", () => {
	test("centers a long excerpt on the literal match", () => {
		const excerpt = searchExcerpt(
			`${"before ".repeat(30)}deployment handoff${" after".repeat(30)}`,
			"deployment handoff",
			80,
		);

		expect(excerpt).toStartWith("…");
		expect(excerpt).toContain("deployment handoff");
		expect(excerpt).toEndWith("…");
	});

	test("treats regex characters as literal text", () => {
		const parts = splitSearchHighlight("Keep 100%_ready and a+b literal", "a+b");

		expect(parts.filter((part) => part.highlighted)).toEqual([{ text: "a+b", highlighted: true }]);
	});

	test("ranks identity matches before supporting text", () => {
		expect(literalSearchRank("deploy", ["Deploy", "release-deploy"], ["runbook"])).toBe(0);
		expect(literalSearchRank("release", ["Deploy", "release-deploy"], ["runbook"])).toBe(3);
		expect(literalSearchRank("runbook", ["Deploy", "release-deploy"], ["runbook"])).toBe(6);
		expect(literalSearchRank("missing", ["Deploy", "release-deploy"], ["runbook"])).toBeNull();
	});
});
