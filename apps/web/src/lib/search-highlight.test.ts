import { describe, expect, test } from "bun:test";
import { searchExcerpt, splitSearchHighlight } from "@/lib/search-highlight";

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
});
