import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OpenClawAdapter } from "./openclaw";

const originalEnv = { ...process.env };
let root = "";
afterEach(() => {
	process.env = { ...originalEnv };
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

test("uses the same official installer for personal and explicit shared-project pulls", async () => {
	root = mkdtempSync(join(tmpdir(), "openclaw-skill-installer-"));
	const bin = join(root, "bin");
	const workspace = join(root, "workspace");
	const log = join(root, "commands.log");
	mkdirSync(bin, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	writeFileSync(
		join(bin, "openclaw"),
		`#!/bin/sh
set -eu
if test "$1 $2 $3" = "agents list --json"; then
  printf '[{"id":"main","workspace":"${workspace}"}]\n'
  exit 0
fi
printf '%s\n' "$*" >> '${log}'
source_dir="$3"
skill_id="$7"
mkdir -p '${workspace}/skills'
rm -rf '${workspace}/skills/'"$skill_id"
cp -R "$source_dir" '${workspace}/skills/'"$skill_id"
`,
	);
	chmodSync(join(bin, "openclaw"), 0o755);
	process.env.PATH = `${bin}:${originalEnv.PATH ?? ""}`;
	process.env.HOME = root;
	process.env.OPENCLAW_STATE_DIR = join(root, "state");
	delete process.env.OPENCLAW_AGENT_ID;
	const sourceDir = join(root, "source", "review-pr");
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR\n");
	const archive = join(root, "review-pr.tar.gz");
	const packed = spawnSync("tar", ["-czf", archive, "-C", dirname(sourceDir), "review-pr"]);
	if (packed.status !== 0) throw new Error("test tar creation failed");
	const bytes = readFileSync(archive);
	const adapter = new OpenClawAdapter();

	await adapter.skills.writeArchive("review-pr", bytes);
	await adapter.skills.writeSharedArchive("review-pr", "alice-a3b4", bytes);

	expect(existsSync(join(workspace, "skills", "review-pr", "SKILL.md"))).toBe(true);
	expect(existsSync(join(workspace, "skills", "review-pr__alice-a3b4", "SKILL.md"))).toBe(true);
	const commands = readFileSync(log, "utf8").trim().split("\n");
	expect(commands[0]).toContain("--as review-pr --force");
	expect(commands[1]).toContain("--as review-pr__alice-a3b4 --force");
});

test("restores an existing Skill when the official installer writes then fails", async () => {
	root = mkdtempSync(join(tmpdir(), "openclaw-skill-installer-rollback-"));
	const bin = join(root, "bin");
	const workspace = join(root, "workspace");
	const target = join(workspace, "skills", "review-pr");
	mkdirSync(bin, { recursive: true });
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "SKILL.md"), "# Original\n");
	writeFileSync(
		join(bin, "openclaw"),
		`#!/bin/sh
set -eu
if test "$1 $2 $3" = "agents list --json"; then
  printf '[{"id":"main","workspace":"${workspace}"}]\n'
  exit 0
fi
skill_id="$7"
rm -rf '${workspace}/skills/'"$skill_id"
mkdir -p '${workspace}/skills/'"$skill_id"
printf '# Partial\n' > '${workspace}/skills/'"$skill_id"/SKILL.md"
exit 23
`,
	);
	chmodSync(join(bin, "openclaw"), 0o755);
	process.env.PATH = `${bin}:${originalEnv.PATH ?? ""}`;
	process.env.HOME = root;
	process.env.OPENCLAW_STATE_DIR = join(root, "state");
	delete process.env.OPENCLAW_AGENT_ID;
	const sourceDir = join(root, "source", "review-pr");
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(join(sourceDir, "SKILL.md"), "# Replacement\n");
	const archive = join(root, "review-pr.tar.gz");
	const packed = spawnSync("tar", ["-czf", archive, "-C", dirname(sourceDir), "review-pr"]);
	if (packed.status !== 0) throw new Error("test tar creation failed");

	await expect(
		new OpenClawAdapter().skills.writeArchive("review-pr", readFileSync(archive)),
	).rejects.toThrow("OpenClaw official Skill install failed");
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Original\n");
});
