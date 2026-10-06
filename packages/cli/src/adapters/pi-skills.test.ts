import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarSingleFile } from "../lib/tar";
import { PiAdapter } from "./pi";
import { agentSkillTargetDir, builtinSkillTargetDir } from "./registry";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalClawdiHome = process.env.CLAWDI_HOME;
let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "clawdi-pi-skills-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "pi");
	process.env.CLAWDI_HOME = join(root, "clawdi");
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
	else process.env.CLAWDI_HOME = originalClawdiHome;
	rmSync(root, { recursive: true, force: true });
});

describe("Pi Skills", () => {
	test("installs, collects, shares, and removes directory bundles while preserving flat Markdown", async () => {
		const adapter = new PiAdapter();
		const skillRoot = join(root, "pi", "skills");
		mkdirSync(skillRoot, { recursive: true });
		const singleFile = join(skillRoot, "single.md");
		writeFileSync(singleFile, "---\nname: single\ndescription: Single-file skill\n---\n");
		const archive = await tarSingleFile(
			"demo",
			"---\nname: demo\ndescription: Demo skill\n---\n# Demo\n",
		);
		await adapter.skills.writeArchive("demo", archive);
		await adapter.skills.writeSharedArchive("demo", "owner", archive);

		expect((await adapter.skills.collect()).map((skill) => skill.skillKey).sort()).toEqual([
			"demo",
			"demo__owner",
		]);
		expect((await adapter.skills.listKeys()).sort()).toEqual(["demo", "demo__owner"]);
		expect(readFileSync(adapter.skills.path("demo"), "utf8")).toContain("# Demo");
		expect(adapter.skills.rootDir()).toBe(skillRoot);
		expect(agentSkillTargetDir("pi", "demo")).toBe(join(skillRoot, "demo"));
		expect(builtinSkillTargetDir("pi")).toBe(join(skillRoot, "clawdi"));
		expect(builtinSkillTargetDir("pi", join(root, "override"))).toBe(
			join(root, "override", "skills", "clawdi"),
		);
		await adapter.skills.remove("demo");
		expect(existsSync(adapter.skills.path("demo"))).toBe(false);
		expect(existsSync(singleFile)).toBe(true);
		expect(await adapter.skills.listKeys()).toEqual(["demo__owner"]);
	});
});
