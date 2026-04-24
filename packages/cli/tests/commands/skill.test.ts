import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillInit } from "../../src/commands/skill";

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
});
