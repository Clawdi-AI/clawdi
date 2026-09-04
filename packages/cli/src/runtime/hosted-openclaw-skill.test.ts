import { afterEach, expect, test } from "bun:test";
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
import {
	repairHostedOpenClawConfig,
	repairHostedOpenClawWorkspace,
	resolveHostedOpenClawWorkspace,
} from "./hosted-openclaw-context";
import { activateHostedOpenClawSkill } from "./hosted-openclaw-skill";

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

	expect(resolveHostedOpenClawWorkspace(home)).toBe(workspaceRoot);
	expect(readFileSync(attempts, "utf8")).toBe("2\n");
});

test("reuses the official roster until its config revision changes", () => {
	root = mkdtempSync(join(tmpdir(), "hosted-openclaw-roster-cache-"));
	const home = join(root, "home");
	const firstWorkspace = join(home, "first-workspace");
	const secondWorkspace = join(home, "second-workspace");
	const command = join(home, ".local", "bin", "openclaw");
	const config = join(home, ".openclaw", "openclaw.json");
	const commandLog = join(root, "commands.log");
	mkdirSync(dirname(command), { recursive: true });
	mkdirSync(dirname(config), { recursive: true });
	writeFileSync(config, '{"agents":{"defaults":{"workspace":"first"}}}\n');
	writeFileSync(
		command,
		`#!/bin/sh
set -eu
printf '%s\n' "$*" >> '${commandLog}'
if grep -q second '${config}'; then
  printf '%s\n' '[{"id":"main","workspace":"${secondWorkspace}"}]'
else
  printf '%s\n' '[{"id":"main","workspace":"${firstWorkspace}"}]'
fi
`,
		{ mode: 0o755 },
	);

	expect(resolveHostedOpenClawWorkspace(home)).toBe(firstWorkspace);
	expect(resolveHostedOpenClawWorkspace(home)).toBe(firstWorkspace);
	expect(readFileSync(commandLog, "utf8").trim().split("\n")).toEqual(["agents list --json"]);

	writeFileSync(config, '{"agents":{"defaults":{"workspace":"second"}}}\n');
	expect(resolveHostedOpenClawWorkspace(home)).toBe(secondWorkspace);
	expect(readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
		"agents list --json",
		"agents list --json",
	]);
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

		expect(() => resolveHostedOpenClawWorkspace(home)).toThrow(
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

	expect(() => resolveHostedOpenClawWorkspace(home)).toThrow(
		"official agent workspace roster is unavailable",
	);
	expect(repairHostedOpenClawConfig(home)).toBe(true);
	expect(resolveHostedOpenClawWorkspace(home)).toBe(workspaceRoot);
	expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toEqual([
		"agents list --json",
		"config validate --json",
		"doctor --fix --non-interactive",
		"agents list --json",
	]);
	expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual(repairedConfig);
});

test("repairs an official state migration failure before retrying the workspace roster", () => {
	root = mkdtempSync(join(tmpdir(), "hosted-openclaw-state-repair-"));
	const home = join(root, "home");
	const workspaceRoot = join(home, "agent-workspace");
	const command = join(home, ".local", "bin", "openclaw");
	const repaired = join(root, "repaired");
	const commandLog = join(root, "commands.log");
	mkdirSync(dirname(command), { recursive: true });
	writeFileSync(
		command,
		`#!/bin/sh
set -eu
printf '%s\n' "$*" >> '${commandLog}'
case "$*" in
  "agents list --json")
    if test ! -f '${repaired}'; then
      printf '%s\n' 'OpenClaw startup migrations did not complete cleanly.' 'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.' >&2
      exit 1
    fi
    printf '%s\n' '[{"id":"main","workspace":"${workspaceRoot}"}]'
    ;;
  "doctor --fix --non-interactive") touch '${repaired}' ;;
  *) exit 64 ;;
esac
`,
	);
	chmodSync(command, 0o755);

	let rosterError: unknown;
	try {
		resolveHostedOpenClawWorkspace(home);
	} catch (error) {
		rosterError = error;
	}
	expect(repairHostedOpenClawWorkspace(home, rosterError)).toBe(true);
	expect(resolveHostedOpenClawWorkspace(home)).toBe(workspaceRoot);
	expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toEqual([
		"agents list --json",
		"doctor --fix --non-interactive",
		"agents list --json",
	]);
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

		expect(() => resolveHostedOpenClawWorkspace(home)).toThrow(
			"official agent workspace roster is unavailable",
		);
		if (scenario.repairInvalidConfig) expect(repairHostedOpenClawConfig(home)).toBe(false);
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
	mkdirSync(dirname(command), { recursive: true });
	writeFileSync(
		command,
		`#!/bin/sh
set -eu
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
`,
	);
	chmodSync(command, 0o755);
	const sourceDir = join(root, "source", "review-pr");
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR\n");
	const target = join(workspaceRoot, "skills", "review-pr");
	const activate = () =>
		activateHostedOpenClawSkill({ home, workspaceRoot, sourceDir, targetDir: target });

	expect(existsSync(workspaceRoot)).toBe(false);
	activate();
	expect(readFileSync(installCwdLog, "utf8")).toBe(`${home}\n`);
	expect(readFileSync(installLog, "utf8")).toMatch(
		/^skills install .* --agent main --as review-pr --force\n$/,
	);
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	activate();
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR v2\n");
	process.env.FAKE_OPENCLAW_FAIL_AFTER_WRITE = "1";
	expect(activate).toThrow("official Skill install failed: exit code 45 without output");
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	delete process.env.FAKE_OPENCLAW_FAIL_AFTER_WRITE;
});

test("reports a spawn error when the official install process cannot start", () => {
	root = mkdtempSync(join(tmpdir(), "hosted-openclaw-spawn-error-"));
	const home = join(root, "home");
	const workspaceRoot = join(home, "agent-workspace");
	const command = join(home, ".local", "bin", "openclaw");
	mkdirSync(dirname(command), { recursive: true });
	writeFileSync(command, "#!/definitely/missing/openclaw-interpreter\n");
	chmodSync(command, 0o755);
	const sourceDir = join(root, "source", "review-pr");
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(join(sourceDir, "SKILL.md"), "# Review PR\n");
	let message = "";
	try {
		activateHostedOpenClawSkill({
			home,
			workspaceRoot,
			sourceDir,
			targetDir: join(workspaceRoot, "skills", "review-pr"),
		});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(message).toContain("OpenClaw official Skill install failed: spawn error:");
	expect(message).toContain("ENOENT");
	expect(message).not.toContain("undefined");
});
