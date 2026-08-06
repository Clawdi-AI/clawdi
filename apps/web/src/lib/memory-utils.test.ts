import { describe, expect, test } from "bun:test";
import { memoryDisplayName } from "@/lib/memory-utils";

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
