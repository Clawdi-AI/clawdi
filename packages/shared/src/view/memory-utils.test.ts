import { describe, expect, test } from "bun:test";
import { memoryDisplayName, memoryRecallLabel } from "@clawdi/shared/view";

describe("memoryDisplayName", () => {
	test("uses readable content identity without exposing storage ids", () => {
		expect(memoryDisplayName("  Prefers concise release notes. Extra detail follows.")).toBe(
			"Prefers concise release notes",
		);
		expect(memoryDisplayName("First line\nSecond line")).toBe("First line");
	});

	test("normalizes whitespace and truncates long labels", () => {
		expect(memoryDisplayName("A   compact   thought", 20)).toBe("A compact thought");
		expect(memoryDisplayName("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghi…");
	});

	test("keeps an empty memory label user-facing", () => {
		expect(memoryDisplayName(" \n ")).toBe("Memory");
	});
});

describe("memoryRecallLabel", () => {
	test("pluralises the recall count and covers never-recalled memories", () => {
		expect(memoryRecallLabel(null)).toBe("Never recalled yet");
		expect(memoryRecallLabel(0)).toBe("Never recalled yet");
		expect(memoryRecallLabel(1)).toBe("Recalled 1 time");
		expect(memoryRecallLabel(3)).toBe("Recalled 3 times");
	});
});
