import { describe, expect, it } from "bun:test";
import { isValidSkillKey, sanitizeSkillKey } from "../src/lib/skill-key";

describe("sanitizeSkillKey", () => {
	it("kebab-cases user-supplied names into valid skill_keys", () => {
		expect(sanitizeSkillKey("My Cool Skill")).toBe("my-cool-skill");
		expect(sanitizeSkillKey("Hello, World!")).toBe("hello-world");
		expect(isValidSkillKey(sanitizeSkillKey("Hello, World!"))).toBe(true);
	});

	it("lowercases", () => {
		expect(sanitizeSkillKey("UPPER")).toBe("upper");
	});

	it("strips leading characters that cannot start a skill_key", () => {
		expect(sanitizeSkillKey("-foo-")).toBe("foo");
		expect(sanitizeSkillKey(".hidden.")).toBe("hidden");
		expect(sanitizeSkillKey("_internal")).toBe("internal");
	});

	it("preserves dots and underscores in the middle", () => {
		expect(sanitizeSkillKey("my_skill.v1")).toBe("my_skill.v1");
	});

	it("falls back to unnamed-skill on empty", () => {
		expect(sanitizeSkillKey("")).toBe("unnamed-skill");
		expect(sanitizeSkillKey("---")).toBe("unnamed-skill");
		expect(sanitizeSkillKey("!@#$")).toBe("unnamed-skill");
	});

	it("caps at the backend skill_key column length", () => {
		const key = sanitizeSkillKey("a".repeat(300));
		expect(key).toHaveLength(200);
		expect(isValidSkillKey(key)).toBe(true);
	});

	it("prevents path traversal attempts", () => {
		expect(sanitizeSkillKey("../etc/passwd")).toBe("etc-passwd");
		expect(sanitizeSkillKey("..")).toBe("unnamed-skill");
	});
});
