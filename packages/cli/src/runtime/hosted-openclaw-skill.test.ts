import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostedOpenClawSkillDriver } from "./hosted-openclaw-skill";

let root = "";
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

test("uses official OpenClaw install and guards manifest cleanup with a content fingerprint", async () => {
	root = mkdtempSync(join(tmpdir(), "hosted-openclaw-driver-"));
	const home = join(root, "home");
	const workspaceRoot = join(home, "agent-workspace");
	const command = join(home, ".local", "bin", "openclaw");
	mkdirSync(dirname(command), { recursive: true });
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(command, `#!/bin/sh
set -eu
test "$1 $2" = "skills install"
source_dir="$3"
shift 3
test "$1" = "--agent"
test "$2" = "main"
test "$3" = "--as"
skill_id="$4"
test "$5" = "--force"
mkdir -p "$PWD/skills"
rm -rf "$PWD/skills/$skill_id"
cp -R "$source_dir" "$PWD/skills/$skill_id"
mkdir -p "$PWD/skills/$skill_id/.openclaw"
printf '{}\n' > "$PWD/skills/$skill_id/.openclaw/source-origin.json"
`);
	chmodSync(command, 0o755);
	const sourceDir = join(root, "source", "review-pr");
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR\n");
	const archive = join(root, "review-pr.tar.gz");
	const packed = spawnSync("tar", ["-czf", archive, "-C", dirname(sourceDir), "review-pr"]);
	if (packed.status !== 0) throw new Error("test tar creation failed");
	const skill = {
		skillId: "review-pr",
		source: { type: "github" as const, url: "https://github.com/Clawdi-AI/store", path: "skills/review-pr", commit: "a".repeat(40) },
		digest: "b".repeat(64),
		tarBytes: readFileSync(archive),
	};

	expect(hostedOpenClawSkillDriver.install({ home, workspaceRoot, skill })).toBe("installed");
	expect(hostedOpenClawSkillDriver.verifyOwned({ workspaceRoot, skill })).toBe(true);
	const target = join(workspaceRoot, "skills", "review-pr");
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	writeFileSync(join(target, "SKILL.md"), "user changed\n");
	expect(() => hostedOpenClawSkillDriver.cleanupManifestOwned({ workspaceRoot, skillId: "review-pr" })).toThrow("ownership receipt");
	expect(existsSync(target)).toBe(true);
	writeFileSync(join(target, "SKILL.md"), "# Review PR\n");
	expect(hostedOpenClawSkillDriver.cleanupManifestOwned({ workspaceRoot, skillId: "review-pr" })).toBe("removed");
	expect(existsSync(target)).toBe(false);
});
