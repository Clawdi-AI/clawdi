import { describe, expect, it } from "bun:test";
import { parseSource } from "../src/lib/source-parser";

describe("parseSource", () => {
	it("parses owner/repo shorthand", () => {
		expect(parseSource("vercel-labs/agent-skills")).toEqual({
			type: "github",
			owner: "vercel-labs",
			repo: "agent-skills",
			path: undefined,
			ref: undefined,
		});
	});

	it("parses owner/repo/subpath", () => {
		const s = parseSource("owner/repo/path/to/skill");
		expect(s).toMatchObject({
			type: "github",
			owner: "owner",
			repo: "repo",
			path: "path/to/skill",
		});
	});

	it("parses owner/repo#ref", () => {
		const s = parseSource("owner/repo#main");
		expect(s).toMatchObject({ type: "github", owner: "owner", repo: "repo", ref: "main" });
	});

	it("parses a full GitHub URL", () => {
		expect(parseSource("https://github.com/vercel-labs/skills")).toMatchObject({
			type: "github",
			owner: "vercel-labs",
			repo: "skills",
		});
	});

	it("parses GitHub URL with /tree/<ref>/subpath", () => {
		const s = parseSource("https://github.com/owner/repo/tree/v1/skills/my-skill");
		expect(s).toMatchObject({
			type: "github",
			owner: "owner",
			repo: "repo",
			ref: "v1",
			path: "skills/my-skill",
		});
	});

	it("parses GitLab URL", () => {
		const s = parseSource("https://gitlab.com/org/repo");
		expect(s).toMatchObject({ type: "gitlab", owner: "org", repo: "repo" });
	});

	it("parses SSH URL", () => {
		const s = parseSource("git@github.com:owner/repo.git");
		expect(s.type).toBe("ssh");
	});

	it("classifies absolute local paths as local", () => {
		expect(parseSource("/tmp/my-skill")).toEqual({ type: "local", path: "/tmp/my-skill" });
	});

	it("classifies relative local paths as local", () => {
		expect(parseSource("./my-skill")).toEqual({ type: "local", path: "./my-skill" });
	});

	it("classifies Windows drive paths as local", () => {
		expect(parseSource("C:\\skills\\my")).toMatchObject({ type: "local" });
	});

	it("throws on malformed input", () => {
		expect(() => parseSource("single-word-only")).toThrow();
	});
});
