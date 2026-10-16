import { expect, test } from "bun:test";
import { sessionSearchQueryError } from "./sessions";

test("session search explains queries outside Web's 2–500 character range", () => {
	expect(sessionSearchQueryError("")).toBeNull();
	expect(sessionSearchQueryError("   ")).toBeNull();
	expect(sessionSearchQueryError("a")).toBe("Type at least 2 characters");
	expect(sessionSearchQueryError("ab")).toBeNull();
	expect(sessionSearchQueryError("a".repeat(500))).toBeNull();
	expect(sessionSearchQueryError("a".repeat(501))).toBe("Type at most 500 characters");
});
