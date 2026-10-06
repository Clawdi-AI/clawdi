import { describe, expect, it } from "bun:test";
import {
	assertValidSkillKey,
	describeSkillKey,
	isValidSkillKey,
	sanitizeSkillKey,
} from "../src/lib/skill-key";

describe("skill key storage contract", () => {
	it.each(["Demo", "team.tools/Demo_v1", "a/b/c/d", "a".repeat(200)])(
		"preserves valid local key %s",
		(key) => expect(isValidSkillKey(key)).toBe(true),
	);
	it.each([
		["", "empty"],
		["中文", "non_ascii"],
		["my skill", "invalid_characters"],
		["demo\n", "invalid_characters"],
		[".system", "invalid_component_start"],
		["team/_private", "invalid_component_start"],
		["team//demo", "invalid_component_start"],
		["a/b/c/d/e", "too_deep"],
		["a".repeat(201), "too_long"],
		["team/download", "reserved_suffix"],
	])("rejects %s and reports only its shape", (key, reason) => {
		expect(isValidSkillKey(key)).toBe(false);
		const description = describeSkillKey(key);
		expect(description).toBe(
			`length=${key.length}, components=${key.split("/").length}, reason=${reason}`,
		);
		expect(() => assertValidSkillKey(key)).toThrow(`Invalid skill_key (${description})`);
	});
});

describe("sanitizeSkillKey", () => {
	it("kebab-cases user-supplied names into valid skill_keys", () => {
		expect(sanitizeSkillKey("My Cool Skill")).toBe("my-cool-skill");
		expect(sanitizeSkillKey("Hello, World!")).toBe("hello-world");
		expect(isValidSkillKey(sanitizeSkillKey("Hello, World!"))).toBe(true);
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
