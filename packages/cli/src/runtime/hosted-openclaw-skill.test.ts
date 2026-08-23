import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const originalSystemctlPath = process.env.CLAWDI_SYSTEMCTL_PATH;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
	if (originalSystemctlPath === undefined) delete process.env.CLAWDI_SYSTEMCTL_PATH;
	else process.env.CLAWDI_SYSTEMCTL_PATH = originalSystemctlPath;
});

test("retries the official workspace roster while the OpenClaw gateway is restarting", () => {
	root = mkdtempSync(join(tmpdir(), "hosted-openclaw-gateway-restart-"));
	const home = join(root, "home");
	const workspaceRoot = join(home, "agent-workspace");
	const command = join(home, ".local", "bin", "openclaw");
	const systemctl = join(root, "systemctl");
	const attempts = join(root, "attempts");
	mkdirSync(dirname(command), { recursive: true });
	writeFileSync(
		command,
		`#!/bin/sh
set -eu
attempt=$(($(cat '${attempts}' 2>/dev/null || printf 0) + 1))
printf '%s\n' "$attempt" > '${attempts}'
if test "$attempt" -eq 1; then exit 1; fi
printf '%s\n' '[{"id":"main","workspace":"${workspaceRoot}"}]'
`,
	);
	writeFileSync(
		systemctl,
		`#!/bin/sh
test "$*" = "--user show openclaw-gateway.service --property=LoadState --property=ActiveState"
printf '%s\n' 'LoadState=loaded' 'ActiveState=deactivating'
`,
	);
	chmodSync(command, 0o755);
	chmodSync(systemctl, 0o755);
	process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;

	expect(hostedOpenClawSkillDriver.resolveWorkspace({ home })).toBe(workspaceRoot);
	expect(readFileSync(attempts, "utf8")).toBe("2\n");
});

test("does not retry roster failures when the OpenClaw gateway failed or is not installed", () => {
	root = mkdtempSync(join(tmpdir(), "hosted-openclaw-gateway-failure-"));
	for (const scenario of [
		{ name: "failed", state: "LoadState=loaded\nActiveState=failed\n", exitCode: 0 },
		{ name: "not-installed", state: "", exitCode: 1 },
	] as const) {
		const home = join(root, scenario.name, "home");
		const command = join(home, ".local", "bin", "openclaw");
		const systemctl = join(root, scenario.name, "systemctl");
		const attempts = join(root, scenario.name, "attempts");
		mkdirSync(dirname(command), { recursive: true });
		writeFileSync(
			command,
			`#!/bin/sh
printf '%s\n' "$*" >> '${attempts}'
exit 1
`,
		);
		writeFileSync(
			systemctl,
			`#!/bin/sh
printf '%s' '${scenario.state}'
exit ${scenario.exitCode}
`,
		);
		chmodSync(command, 0o755);
		chmodSync(systemctl, 0o755);
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;

		expect(() => hostedOpenClawSkillDriver.resolveWorkspace({ home })).toThrow(
			"official agent workspace roster is unavailable",
		);
		expect(readFileSync(attempts, "utf8")).toBe("agents list --json\n");
	}
});

test("repairs typed invalid config once before retrying the official workspace roster", () => {
	root = mkdtempSync(join(tmpdir(), "hosted-openclaw-config-repair-"));
	const home = join(root, "home");
	const workspaceRoot = join(home, "agent-workspace");
	const command = join(home, ".local", "bin", "openclaw");
	const configPath = join(home, ".openclaw", "openclaw.json");
	const repairedConfigPath = join(root, "repaired-openclaw.json");
	const commandLog = join(root, "commands.log");
	const repairedConfig = {
		meta: { lastTouchedVersion: "2026.8.1-beta.2" },
		commands: { restart: true },
		cron: { enabled: true },
		gateway: {
			mode: "local",
			controlUi: { allowedOrigins: ["https://agent.example.test"] },
		},
	};
	mkdirSync(dirname(command), { recursive: true });
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(
		configPath,
		`${JSON.stringify({
			meta: { ...repairedConfig.meta, lastTouchedAt: "2026-08-15T00:00:00.000Z" },
			commands: { ...repairedConfig.commands, ownerDisplay: "raw" },
			cron: { ...repairedConfig.cron, maxConcurrentRuns: 2 },
			gateway: {
				...repairedConfig.gateway,
				controlUi: {
					...repairedConfig.gateway.controlUi,
					allowInsecureAuth: false,
				},
			},
		})}\n`,
	);
	writeFileSync(repairedConfigPath, `${JSON.stringify(repairedConfig)}\n`);
	const validation = JSON.stringify({
		valid: false,
		path: configPath,
		issues: [
			{ path: "meta", message: "retired metadata field" },
			{ path: "commands", message: "retired command field" },
			{ path: "cron", message: "retired cron field" },
			{ path: "gateway.controlUi", message: "retired control UI field" },
		],
	});
	writeFileSync(
		command,
		`#!/bin/sh
set -eu
printf '%s\n' "$*" >> '${commandLog}'
case "$*" in
  "agents list --json")
    if grep -Eq 'lastTouchedAt|ownerDisplay|maxConcurrentRuns|allowInsecureAuth' '${configPath}'; then
      exit 2
    fi
    printf '%s\n' '[{"id":"main","workspace":"${workspaceRoot}"}]'
    ;;
  "config validate --json")
    printf '%s\n' '${validation}'
    exit 1
    ;;
  "doctor --fix --non-interactive")
    cp '${repairedConfigPath}' '${configPath}'
    ;;
  *) exit 64 ;;
esac
`,
	);
	chmodSync(command, 0o755);

	expect(hostedOpenClawSkillDriver.resolveWorkspace({ home, repairInvalidConfig: true })).toBe(
		workspaceRoot,
	);
	expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toEqual([
		"agents list --json",
		"config validate --json",
		"doctor --fix --non-interactive",
		"agents list --json",
	]);
	expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual(repairedConfig);
});

test("does not repair without opt-in or a definitive invalid-config validation", () => {
	root = mkdtempSync(join(tmpdir(), "hosted-openclaw-config-no-repair-"));
	const scenarios = [
		{
			name: "default",
			repairInvalidConfig: undefined,
			validation:
				'{"valid":false,"path":"/tmp/openclaw.json","issues":[{"path":"x","message":"x"}]}',
			validationExit: 1,
			expectedCommands: ["agents list --json"],
		},
		{
			name: "valid-config",
			repairInvalidConfig: true,
			validation: '{"valid":true,"path":"/tmp/openclaw.json","warnings":[]}',
			validationExit: 0,
			expectedCommands: ["agents list --json", "config validate --json"],
		},
		{
			name: "ambiguous-invalid-config",
			repairInvalidConfig: true,
			validation: '{"valid":false,"path":"/tmp/openclaw.json","issues":[]}',
			validationExit: 1,
			expectedCommands: ["agents list --json", "config validate --json"],
		},
		{
			name: "malformed-validation",
			repairInvalidConfig: true,
			validation: "not-json",
			validationExit: 1,
			expectedCommands: ["agents list --json", "config validate --json"],
		},
	] as const;

	for (const scenario of scenarios) {
		const home = join(root, scenario.name, "home");
		const command = join(home, ".local", "bin", "openclaw");
		const commandLog = join(root, scenario.name, "commands.log");
		mkdirSync(dirname(command), { recursive: true });
		writeFileSync(
			command,
			`#!/bin/sh
printf '%s\n' "$*" >> '${commandLog}'
if test "$*" = "config validate --json"; then
  printf '%s\n' '${scenario.validation}'
  exit ${scenario.validationExit}
fi
exit 2
`,
		);
		chmodSync(command, 0o755);

		expect(() =>
			hostedOpenClawSkillDriver.resolveWorkspace({
				home,
				repairInvalidConfig: scenario.repairInvalidConfig,
			}),
		).toThrow("official agent workspace roster is unavailable");
		expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toEqual([
			...scenario.expectedCommands,
		]);
	}
});

test("runs official install from home and rolls back failed replacement", () => {
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
	const tarBytes = readFileSync(archive);
	const skill = {
		skillId: "review-pr",
		source: {
			type: "github" as const,
			url: "https://github.com/Clawdi-AI/store",
			path: "skills/review-pr",
			commit: "a".repeat(40),
		},
		sourceIdentity: `github\0review-pr\0https://github.com/Clawdi-AI/store\0skills/review-pr\0${"a".repeat(40)}`,
		archiveSha256: createHash("sha256").update(tarBytes).digest("hex"),
		tarBytes,
	};

	expect(existsSync(workspaceRoot)).toBe(false);
	expect(hostedOpenClawSkillDriver.install({ home, workspaceRoot, skill })).toBe("installed");
	expect(readFileSync(installCwdLog, "utf8")).toBe(`${home}\n`);
	expect(readFileSync(installLog, "utf8")).toMatch(
		/^skills install .* --agent main --as review-pr --force\n$/,
	);
	const target = join(workspaceRoot, "skills", "review-pr");
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	expect(
		hostedOpenClawSkillDriver.installDirectory({
			home,
			workspaceRoot,
			skillId: "review-pr",
			sourceDir,
		}),
	).toBe("installed");
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR v2\n");
	process.env.FAKE_OPENCLAW_FAIL_AFTER_WRITE = "1";
	expect(() =>
		hostedOpenClawSkillDriver.installDirectory({
			home,
			workspaceRoot,
			skillId: "review-pr",
			sourceDir,
		}),
	).toThrow("official Skill install failed: exit code 45 without output");
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	delete process.env.FAKE_OPENCLAW_FAIL_AFTER_WRITE;
	process.env.FAKE_OPENCLAW_DRIFT_AFTER_WRITE = "1";
	expect(() =>
		hostedOpenClawSkillDriver.installDirectory({
			home,
			workspaceRoot,
			skillId: "review-pr",
			sourceDir,
		}),
	).toThrow("changed during Skill reconciliation");
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	delete process.env.FAKE_OPENCLAW_DRIFT_AFTER_WRITE;
	rmSync(workspaceDriftMarker);
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
		});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(message).toContain("OpenClaw official Skill install failed: spawn error:");
	expect(message).toContain("ENOENT");
	expect(message).not.toContain("undefined");
});
