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
import { hostedOpenClawSkillDriver } from "./hosted-openclaw-skill";

let root = "";
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

test("runs official install from home before its first workspace exists and guards cleanup", async () => {
	root = mkdtempSync(join(tmpdir(), "hosted-openclaw-driver-"));
	const home = join(root, "home");
	const workspaceRoot = join(home, "agent-workspace");
	const command = join(home, ".local", "bin", "openclaw");
	const installLog = join(root, "install.log");
	const installCwdLog = join(root, "install-cwd.log");
	const workspaceDriftMarker = join(root, "workspace-drift");
	mkdirSync(dirname(command), { recursive: true });
	writeFileSync(
		command,
		`#!/bin/sh
set -eu
if test "$1 $2 $3" = "agents list --json"; then
  if test -f '${workspaceDriftMarker}'; then
    printf '[{"id":"main","workspace":"${join(home, "different-workspace")}"}]\n'
    exit 0
  fi
  printf '%s\n' '[{"id":"main","workspace":"${workspaceRoot}"}]'
  exit 0
fi
test "$1 $2" = "skills install"
printf '%s\n' "$*" >> '${installLog}'
printf '%s\n' "$PWD" >> '${installCwdLog}'
source_dir="$3"
shift 3
test "$1" = "--agent"
test "$2" = "main"
test "$3" = "--as"
skill_id="$4"
test "$5" = "--force"
mkdir -p '${workspaceRoot}/skills'
rm -rf '${workspaceRoot}/skills/'"$skill_id"
cp -R "$source_dir" '${workspaceRoot}/skills/'"$skill_id"
mkdir -p '${workspaceRoot}/skills/'"$skill_id"'/.openclaw'
printf '{}\n' > '${workspaceRoot}/skills/'"$skill_id"'/.openclaw/source-origin.json'
if test "\${FAKE_OPENCLAW_FAIL_AFTER_WRITE:-}" = "1"; then exit 45; fi
if test "\${FAKE_OPENCLAW_DRIFT_AFTER_WRITE:-}" = "1"; then touch '${workspaceDriftMarker}'; fi
`,
	);
	chmodSync(command, 0o755);
	const sourceDir = join(root, "source", "review-pr");
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR\n");
	const archive = join(root, "review-pr.tar.gz");
	const packed = spawnSync("tar", ["-czf", archive, "-C", dirname(sourceDir), "review-pr"]);
	if (packed.status !== 0) throw new Error("test tar creation failed");
	const skill = {
		skillId: "review-pr",
		source: {
			type: "github" as const,
			url: "https://github.com/Clawdi-AI/store",
			path: "skills/review-pr",
			commit: "a".repeat(40),
		},
		sourceIdentity: `github\0review-pr\0https://github.com/Clawdi-AI/store\0skills/review-pr\0${"a".repeat(40)}`,
		archiveSha256: "b".repeat(64),
		tarBytes: readFileSync(archive),
	};

	expect(existsSync(workspaceRoot)).toBe(false);
	expect(hostedOpenClawSkillDriver.install({ home, workspaceRoot, skill })).toBe("installed");
	expect(readFileSync(installCwdLog, "utf8")).toBe(`${home}\n`);
	expect(readFileSync(installLog, "utf8")).toMatch(
		/^skills install .* --agent main --as review-pr --force\n$/,
	);
	expect(hostedOpenClawSkillDriver.verifyOwned({ workspaceRoot, skill })).toBe(true);
	const target = join(workspaceRoot, "skills", "review-pr");
	const receipt = join(workspaceRoot, "skills", ".clawdi-manifest-receipts", "review-pr.json");
	const receiptBytes = readFileSync(receipt);
	rmSync(receipt);
	expect(hostedOpenClawSkillDriver.verifyOwned({ workspaceRoot, skill })).toBe(false);
	writeFileSync(receipt, receiptBytes);
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR v2\n");
	process.env.FAKE_OPENCLAW_FAIL_AFTER_WRITE = "1";
	expect(() =>
		hostedOpenClawSkillDriver.installDirectory({
			home,
			workspaceRoot,
			skillId: "review-pr",
			sourceDir,
			ownershipIdentity: `${skill.sourceIdentity}-v2`,
		}),
	).toThrow("official Skill install failed: exit code 45 without output");
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	expect(hostedOpenClawSkillDriver.verifyOwned({ workspaceRoot, skill })).toBe(true);
	delete process.env.FAKE_OPENCLAW_FAIL_AFTER_WRITE;
	process.env.FAKE_OPENCLAW_DRIFT_AFTER_WRITE = "1";
	expect(() =>
		hostedOpenClawSkillDriver.installDirectory({
			home,
			workspaceRoot,
			skillId: "review-pr",
			sourceDir,
			ownershipIdentity: `${skill.sourceIdentity}-v2`,
		}),
	).toThrow("changed during Skill reconciliation");
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	expect(hostedOpenClawSkillDriver.verifyOwned({ workspaceRoot, skill })).toBe(true);
	delete process.env.FAKE_OPENCLAW_DRIFT_AFTER_WRITE;
	rmSync(workspaceDriftMarker);
	writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR\n");
	writeFileSync(join(target, "SKILL.md"), "user changed\n");
	expect(() =>
		hostedOpenClawSkillDriver.cleanupManifestOwned({
			workspaceRoot,
			skillId: "review-pr",
			ownershipIdentity: skill.sourceIdentity,
		}),
	).toThrow("ownership receipt");
	expect(existsSync(target)).toBe(true);
	writeFileSync(join(target, "SKILL.md"), "# Review PR\n");
	expect(
		hostedOpenClawSkillDriver.cleanupManifestOwned({
			workspaceRoot,
			skillId: "review-pr",
			ownershipIdentity: skill.sourceIdentity,
		}),
	).toBe("removed");
	expect(existsSync(target)).toBe(false);
	writeFileSync(receipt, "{}\n");
	expect(
		hostedOpenClawSkillDriver.cleanupManifestOwned({
			workspaceRoot,
			skillId: "review-pr",
			ownershipIdentity: skill.sourceIdentity,
		}),
	).toBe("absent");
	expect(existsSync(receipt)).toBe(false);
});

test("fails before official install when the OpenClaw workspace changes during reconciliation", async () => {
	root = mkdtempSync(join(tmpdir(), "hosted-openclaw-workspace-mismatch-"));
	const home = join(root, "home");
	const workspaceRoot = join(home, "desired-workspace");
	const command = join(home, ".local", "bin", "openclaw");
	const installMarker = join(root, "install-called");
	mkdirSync(dirname(command), { recursive: true });
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(
		command,
		`#!/bin/sh
if test "$1 $2 $3" = "agents list --json"; then
  printf '[{"id":"main","workspace":"${join(home, "different-workspace")}"}]\n'
  exit 0
fi
touch '${installMarker}'
exit 0
`,
	);
	chmodSync(command, 0o755);
	const sourceDir = join(root, "source", "review-pr");
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR\n");
	expect(() =>
		hostedOpenClawSkillDriver.installDirectory({
			home,
			workspaceRoot,
			skillId: "review-pr",
			sourceDir,
			ownershipIdentity:
				"github\0review-pr\0https://github.com/Clawdi-AI/store\0skills/review-pr\0" +
				"a".repeat(40),
		}),
	).toThrow("changed during Skill reconciliation");
	expect(existsSync(installMarker)).toBe(false);
	expect(existsSync(join(workspaceRoot, "skills", "review-pr"))).toBe(false);
});

test("reports a spawn error when the official install process cannot start", () => {
	root = mkdtempSync(join(tmpdir(), "hosted-openclaw-spawn-error-"));
	const home = join(root, "home");
	const workspaceRoot = join(home, "agent-workspace");
	const command = join(home, ".local", "bin", "openclaw");
	mkdirSync(dirname(command), { recursive: true });
	writeFileSync(
		command,
		`#!/bin/sh
if test "$1 $2 $3" = "agents list --json"; then
  printf '[{"id":"main","workspace":"${workspaceRoot}"}]\n'
  printf '%s\n' '#!/definitely/missing/openclaw-interpreter' > "$0"
  exit 0
fi
exit 64
`,
	);
	chmodSync(command, 0o755);
	const sourceDir = join(root, "source", "review-pr");
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR\n");
	let message = "";
	try {
		hostedOpenClawSkillDriver.installDirectory({
			home,
			workspaceRoot,
			skillId: "review-pr",
			sourceDir,
			ownershipIdentity:
				"github\0review-pr\0https://github.com/Clawdi-AI/store\0skills/review-pr\0" +
				"a".repeat(40),
		});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(message).toContain("OpenClaw official Skill install failed: spawn error:");
	expect(message).toContain("ENOENT");
	expect(message).not.toContain("undefined");
});
