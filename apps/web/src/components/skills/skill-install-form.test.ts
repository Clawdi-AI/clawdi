import { describe, expect, test } from "bun:test";
import { parseSkillRepository } from "./skill-install-repository";

describe("Skill install repository parsing", () => {
	test("accepts supported shorthand and GitHub URLs", () => {
		expect(parseSkillRepository("owner/repo")).toEqual({ repo: "owner/repo" });
		expect(parseSkillRepository("https://github.com/owner/repo/skills/review/")).toEqual({
			repo: "owner/repo",
			path: "skills/review",
		});
	});

	test("rejects incomplete repository identities", () => {
		expect(parseSkillRepository("")).toBeNull();
		expect(parseSkillRepository("owner-only")).toBeNull();
		expect(parseSkillRepository("https://example.com/owner/repo")).toBeNull();
		expect(parseSkillRepository("http://github.com/owner/repo")).toBeNull();
		expect(parseSkillRepository("https://github.com/owner/repo?tab=readme")).toBeNull();
		expect(parseSkillRepository("owner/repo/../other")).toBeNull();
	});
});
