import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentType } from "../../src/adapters/agent-types";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "..", "fixtures");

/**
 * Copy a fixture HOME to a fresh tmpdir and return the tmpdir path.
 *
 * Tests should set `process.env.HOME = tmpHome` immediately after calling
 * this — lib/config.ts and adapters/paths.ts read $HOME lazily on every call.
 */
export function copyFixtureToTmp(agent: AgentType): string {
	const fixtureName = agent === "claude_code" ? "claude-code" : agent;
	const src = join(fixturesRoot, fixtureName);
	const dst = join(
		tmpdir(),
		`clawdi-fixture-${fixtureName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dst, { recursive: true });
	cpSync(src, dst, { recursive: true });
	return dst;
}

export function cleanupTmp(tmp: string) {
	rmSync(tmp, { recursive: true, force: true });
}

export function addSkillDirectorySymlinkCases(skillsRoot: string, outsideRoot: string): string {
	const source = join(skillsRoot, "source", "linked-source");
	mkdirSync(source, { recursive: true });
	writeFileSync(join(source, "SKILL.md"), "---\nname: linked\ndescription: Linked skill\n---\n");
	const linked = join(skillsRoot, "linked");
	symlinkSync(source, linked, "dir");

	symlinkSync(join(skillsRoot, "missing"), join(skillsRoot, "broken"), "dir");
	mkdirSync(outsideRoot, { recursive: true });
	writeFileSync(join(outsideRoot, "SKILL.md"), "# outside\n");
	symlinkSync(outsideRoot, join(skillsRoot, "escaping"), "dir");
	writeFileSync(join(skillsRoot, "plain-file"), "not a directory\n");
	symlinkSync(join(skillsRoot, "plain-file"), join(skillsRoot, "file-link"));
	symlinkSync(join(skillsRoot, "cycle-b"), join(skillsRoot, "cycle-a"), "dir");
	symlinkSync(join(skillsRoot, "cycle-a"), join(skillsRoot, "cycle-b"), "dir");

	const skipped = join(skillsRoot, "node_modules", "hidden-skill");
	mkdirSync(skipped, { recursive: true });
	writeFileSync(join(skipped, "SKILL.md"), "# skipped\n");
	symlinkSync(skipped, join(skillsRoot, "skip-bypass"), "dir");
	return linked;
}
