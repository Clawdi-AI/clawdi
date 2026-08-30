import { describe, expect, test } from "bun:test";
import {
	literalSearchRank,
	searchExcerpt,
	searchTerms,
	splitSearchHighlight,
} from "@/lib/search-highlight";

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

	test("highlights every unique term in a multi-word query", () => {
		expect(searchTerms("  Handoff deploy handoff  ")).toEqual(["Handoff", "deploy"]);
		const highlighted = splitSearchHighlight(
			"Deploy the release before the final handoff",
			"handoff deploy",
		)
			.filter((part) => part.highlighted)
			.map((part) => part.text.toLocaleLowerCase());

		expect(highlighted).toEqual(["deploy", "handoff"]);
	});

	test("centers excerpts on the earliest term when the phrase is not contiguous", () => {
		const excerpt = searchExcerpt(
			`${"before ".repeat(30)}deployment is ready${" gap".repeat(30)}handoff${" after".repeat(30)}`,
			"handoff deployment",
			80,
		);

		expect(excerpt).toContain("deployment");
	});

	test("ranks identity matches before supporting text", () => {
		expect(literalSearchRank("deploy", ["Deploy", "release-deploy"], ["runbook"])).toBe(0);
		expect(literalSearchRank("release", ["Deploy", "release-deploy"], ["runbook"])).toBe(3);
		expect(literalSearchRank("runbook", ["Deploy", "release-deploy"], ["runbook"])).toBe(6);
		expect(literalSearchRank("missing", ["Deploy", "release-deploy"], ["runbook"])).toBeNull();
	});

	test("matches all terms across identity and supporting fields", () => {
		expect(
			literalSearchRank("handoff deploy", ["Deploy service"], ["Release handoff notes"]),
		).not.toBeNull();
		expect(
			literalSearchRank("handoff missing", ["Deploy service"], ["Release handoff notes"]),
		).toBeNull();
	});
});
