import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillAdd, skillInit } from "../../src/commands/skill";
import { jsonResponse, mockFetch, okEnvironmentProbe, seedAuthAndEnv } from "./helpers";

let tmpHome: string;
let origCwd: string;
let origHome: string | undefined;

beforeEach(() => {
	origCwd = process.cwd();
	origHome = process.env.HOME;
	tmpHome = join(tmpdir(), `clawdi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpHome, { recursive: true });
	process.env.HOME = tmpHome;
	process.chdir(tmpHome);
});

afterEach(() => {
	process.chdir(origCwd);
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("skillInit", () => {
	it("writes SKILL.md template when given a name", () => {
		skillInit("my-skill");
		const p = join(tmpHome, "my-skill", "SKILL.md");
		expect(existsSync(p)).toBe(true);
		const content = readFileSync(p, "utf-8");
		expect(content).toContain("---\nname: my-skill");
		expect(content).toContain("description: A brief description");
	});

	it("writes SKILL.md in the current directory when no name is given", () => {
		// basename(cwd) → last path segment of tmpdir
		skillInit();
		const p = join(tmpHome, "SKILL.md");
		expect(existsSync(p)).toBe(true);
	});

	it("does not overwrite an existing SKILL.md", () => {
		const existing = join(tmpHome, "existing-skill");
		mkdirSync(existing, { recursive: true });
		writeFileSync(join(existing, "SKILL.md"), "ORIGINAL CONTENT");
		// skillInit uses cwd's name if none passed; pass explicit to hit the named path
		skillInit("existing-skill");
		expect(readFileSync(join(existing, "SKILL.md"), "utf-8")).toBe("ORIGINAL CONTENT");
	});

	it("sanitizes the name to kebab-case", () => {
		skillInit("My Cool Skill!");
		expect(existsSync(join(tmpHome, "my-cool-skill", "SKILL.md"))).toBe(true);
	});

	it("caps generated skill directory names at the backend skill_key limit", () => {
		skillInit("a".repeat(300));
		const generated = "a".repeat(200);
		expect(existsSync(join(tmpHome, generated, "SKILL.md"))).toBe(true);
	});
});

describe("skillAdd", () => {
	it("uploads a backend-valid skill_key generated from a long local directory name", async () => {
		seedAuthAndEnv(tmpHome, "claude_code");
		const longName = "a".repeat(240);
		const skillDir = join(tmpHome, longName);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: Long Skill\ndescription: long directory name\n---\n# Long\n",
		);

		const projectId = "00000000-0000-0000-0000-000000000099";
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: `/api/projects/${projectId}/skills/upload`,
				response: (request) =>
					jsonResponse({
						skill_key: request.multipartFields?.skill_key,
						version: 1,
						file_count: 1,
					}),
			},
		]);
		try {
			await skillAdd(skillDir, { agent: "claude_code", yes: true });
		} finally {
			restore();
		}

		const upload = captured.find((c) => c.path === `/api/projects/${projectId}/skills/upload`);
		expect(upload?.multipartFields?.skill_key).toHaveLength(200);
		expect(upload?.multipartFields?.skill_key).toBe("a".repeat(200));
	});
});
