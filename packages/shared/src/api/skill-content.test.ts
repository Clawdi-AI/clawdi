import { describe, expect, test } from "bun:test";
import {
	buildSkillCreateRequest,
	buildSkillUpdateRequest,
	parseProjectSkillGitHubInput,
	stripFrontmatter,
} from "./skill-content";

describe("shared Skill content", () => {
	test("strips only leading YAML and preserves body separators", () => {
		expect(stripFrontmatter("---\r\nname: demo\r\n---\r\n# Body\n---\nEnd")).toBe(
			"# Body\n---\nEnd",
		);
		expect(stripFrontmatter("# Body\n---\nEnd")).toBe("# Body\n---\nEnd");
		expect(stripFrontmatter("---\nunterminated")).toBe("---\nunterminated");
	});
	test("builds an immutable edit with the revision captured when editing started", () => {
		const draft = { name: "demo", description: "Example", instructions: "  # Body\n " };
		const revision = "a".repeat(64);
		expect(buildSkillCreateRequest(draft).instructions).toBe("# Body");
		expect(buildSkillUpdateRequest(draft, revision)).toEqual({
			...draft,
			instructions: "# Body",
			content_hash: revision,
		});
		expect(draft.instructions).toBe("  # Body\n ");
		for (const invalid of ["", "a".repeat(63), "A".repeat(64)])
			expect(() => buildSkillUpdateRequest(draft, invalid)).toThrow();
	});
	test("accepts canonical GitHub repositories and project Skill paths", () => {
		expect(parseProjectSkillGitHubInput(" owner/repository ")).toEqual({
			repo: "owner/repository",
			path: undefined,
		});
		expect(
			parseProjectSkillGitHubInput("https://github.com/owner/repository/skills/demo/"),
		).toEqual({ repo: "owner/repository", path: "skills/demo" });
	});
	test("rejects ambiguous URLs and paths before normalization", () => {
		for (const input of [
			"http://github.com/a/b",
			"https://example.com/a/b",
			"https://user@github.com/a/b",
			"https://github.com/a/b?ref=x",
			"https://github.com/a/b#x",
			"https://github.com/a/b/../c",
			"https://github.com/a/b/%2e%2e/c",
			"a/b/./c",
			"a/b//c",
			"a/b/..",
			"a/b/a b",
			`a/b/${"a".repeat(201)}`,
			"https://github.com/a\\b/c",
		]) {
			expect(() => parseProjectSkillGitHubInput(input)).toThrow();
		}
	});
});
