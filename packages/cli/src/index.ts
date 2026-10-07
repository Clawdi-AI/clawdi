#!/usr/bin/env node
import { Console } from "node:console";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { Command, Help, type Option } from "commander";
import { registerAgent } from "./cli/register/agent.js";
import { registerAiProvider } from "./cli/register/ai-provider.js";
import { registerAuth } from "./cli/register/auth.js";
import { registerCapabilities } from "./cli/register/capabilities.js";
import { registerChannel } from "./cli/register/channel.js";
import { registerConfig } from "./cli/register/config.js";
import { registerDaemon } from "./cli/register/daemon.js";
import { registerDeploy } from "./cli/register/deploy.js";
import { registerDoctor } from "./cli/register/doctor.js";
import { registerInbox } from "./cli/register/inbox.js";
import { registerInject } from "./cli/register/inject.js";
import { registerMcp } from "./cli/register/mcp.js";
import { registerMemory } from "./cli/register/memory.js";
import { registerProject } from "./cli/register/project.js";
import { registerPull } from "./cli/register/pull.js";
import { registerPush } from "./cli/register/push.js";
import { registerRead } from "./cli/register/read.js";
import { registerRun } from "./cli/register/run.js";
import { registerRuntime } from "./cli/register/runtime.js";
import { registerSession } from "./cli/register/session.js";
import { registerSetup } from "./cli/register/setup.js";
import { registerSkill } from "./cli/register/skill.js";
import { registerStatus } from "./cli/register/status.js";
import { registerTeardown } from "./cli/register/teardown.js";
import { registerUpdate } from "./cli/register/update.js";
import { registerVault } from "./cli/register/vault.js";
import { registerWallet } from "./cli/register/wallet.js";
import { getClawdiDir } from "./lib/config.js";
import { handleError } from "./lib/errors.js";
import { getCliVersion } from "./lib/version.js";
import { evaluateHostPolicyForCommand } from "./runtime/host-policy.js";

const program = new Command();

function disableColor(): void {
	chalk.level = 0;
	// Clack uses node:util styleText, which honors FORCE_COLOR=0.
	process.env.FORCE_COLOR = "0";
	// Bun's built-in console caches color support before startup. Use standard
	// Console methods so errors, warnings, and inspected values stay plain.
	Object.assign(
		globalThis.console,
		new Console({ stdout: process.stdout, stderr: process.stderr, colorMode: false }),
	);
}

const args = process.argv.slice(2);
const separatorIndex = args.indexOf("--");
const cliArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
if (process.env.NO_COLOR || cliArgs.includes("--no-color")) disableColor();
// Color is process configuration, not a command option. Keep it out of
// optsWithGlobals() and preserve arguments forwarded after `--`.
const commandArgs = [
	...cliArgs.filter((arg) => arg !== "--no-color"),
	...(separatorIndex === -1 ? [] : args.slice(separatorIndex)),
];

function commandPath(command: Command): string {
	const names: string[] = [];
	let current: Command | null = command;
	while (current) {
		const name = current.name();
		if (name && name !== "clawdi") names.push(name);
		current = current.parent ?? null;
	}
	return names.reverse().join(" ");
}

program
	.name("clawdi")
	.description(
		"The best home for all your AI agents. Run them in the cloud or connect your own—with their context and tools in one place.",
	)
	.version(getCliVersion())
	.addHelpText(
		"afterAll",
		"\nGlobal options:\n  --no-color  Disable color output (accepted by every command, before --)\n\nExit codes:\n  0  success\n  1  command or API error\n  2  session extract is not configured\n  4  authorization required",
	)
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi auth login               Sign in to Clawdi
  $ clawdi deploy                   Create a Cloud Agent with the deploy wizard
  $ clawdi auth status --json       Inspect credential source without printing secrets
  $ clawdi setup                    Detect agents and register the current machine
  $ clawdi session list             Preview local sessions before pushing
  $ clawdi push --all               Upload everything (every agent, project, module)
  $ clawdi pull --all               Mirror sessions for all registered agents
  $ clawdi skill list --json        Machine-readable skill listing
  $ clawdi memory search "redis"    Search memories by text
  $ clawdi vault set OPENAI_API_KEY Store a secret
  $ clawdi project folder link --project engineering  Use this folder with a project
  $ clawdi run --env-file .env.clawdi -- npm run dev  Resolve clawdi:// refs at runtime

Environment:
  CLAWDI_API_URL           Override the Clawdi API endpoint
  CLAWDI_DEPLOY_API_URL    Override the deploy API endpoint
  CLAWDI_AUTH_TOKEN_ORIGIN CLAWDI_API_URL origin that CLAWDI_AUTH_TOKEN is bound to
  CLAWDI_DEBUG             Print stack traces on error
  CLAWDI_NO_UPDATE_CHECK   Suppress the non-blocking update check
  CLAWDI_NO_AUTO_UPDATE    Skip CLI/daemon background auto-update (also disables via \`config set autoUpdate false\`)
  CLAWDI_AUTH_TOKEN        Authenticate non-interactive Cloud API requests
  NO_COLOR                Disable color output when non-empty
  CLAUDE_CONFIG_DIR        Custom Claude Code home (else ~/.claude)
  CODEX_HOME               Custom Codex home (else ~/.codex)
  HERMES_HOME              Custom Hermes home (else ~/.hermes)
  OPENCLAW_STATE_DIR       Custom OpenClaw state dir (else auto-detect)
  OPENCLAW_AGENT_ID        OpenClaw agent id (else "main")
  PI_CODING_AGENT_DIR      Custom Pi agent home (else ~/.pi/agent)
  OPENCODE_DB              Custom OpenCode SQLite path (else XDG data/opencode/opencode.db)
  CI / GITHUB_ACTIONS / …  Disable interactive prompts in known CI

Docs: https://github.com/Clawdi-AI/clawdi`,
	);

program.hook("preAction", (_thisCommand, actionCommand) => {
	const command = commandPath(actionCommand);
	const decision = evaluateHostPolicyForCommand(command);
	if (decision.allowed) return;
	const reason = decision.reason ?? "disabled by Cloud Agent runtime policy";
	throw new Error(`Command \`clawdi ${command}\` is disabled inside Cloud Agents: ${reason}`);
});

registerDeploy(program);
registerAuth(program);
registerStatus(program);
registerWallet(program);
registerConfig(program);
registerSetup(program);
registerTeardown(program);
registerPush(program);
registerPull(program);
registerDaemon(program);
registerAiProvider(program);
registerChannel(program);
registerRuntime(program);
registerVault(program);
registerRead(program);
registerInject(program);
registerSkill(program);
registerSession(program);
registerMemory(program);
registerDoctor(program);
registerCapabilities(program);
registerUpdate(program);
registerMcp(program);
registerRun(program);
registerProject(program);
registerAgent(program);
registerInbox(program);

// Keep the top-level help scannable without changing the command registry or
// exposing any of the hidden hosted-runtime commands. Commander 15 renders
// each heading in the order its first grouped command appears.
const TOP_LEVEL_HELP_GROUPS: Readonly<Record<string, readonly string[]>> = {
	"Get started": ["auth", "setup", "status", "doctor"],
	Sync: ["push", "pull", "session", "daemon"],
	Context: ["skill", "memory", "vault", "project", "inbox"],
	Secrets: ["run", "read", "inject"],
	"Cloud Agents": ["deploy", "agent", "ai-provider", "channel", "wallet"],
	Maintenance: ["config", "update", "teardown", "mcp"],
};

class TopLevelHelp extends Help {
	override groupItems<T extends Command | Option>(
		unsortedItems: T[],
		visibleItems: T[],
		getGroup: (item: T) => string,
	): Map<string, T[]> {
		const groups = super.groupItems(unsortedItems, visibleItems, getGroup);
		const ordered = new Map<string, T[]>();
		for (const heading of [...Object.keys(TOP_LEVEL_HELP_GROUPS), "Commands:"]) {
			const items = groups.get(heading);
			if (items) ordered.set(heading, items);
		}
		for (const [heading, items] of groups) {
			if (!ordered.has(heading)) ordered.set(heading, items);
		}
		return ordered;
	}
}

program.createHelp = () => new TopLevelHelp();

for (const [heading, commandNames] of Object.entries(TOP_LEVEL_HELP_GROUPS)) {
	for (const commandName of commandNames) {
		program.commands.find((command) => command.name() === commandName)?.helpGroup(heading);
	}
}

// Auto-update tick: prints any "✓ Updated to v…" notice from a previous
// run's background install, and (when due) kicks off another detached
// install. Best-effort and fully off-the-hot-path — see commands/update.ts.
(async () => {
	try {
		await rm(join(getClawdiDir(), "profile-renames"), { recursive: true, force: true });
	} catch {
		// Obsolete journal cleanup must not prevent the CLI from running.
	}
	try {
		const { maybeAutoUpdate } = await import("./commands/update.js");
		await maybeAutoUpdate();
	} catch {
		// auto-update is opportunistic; never let it kill the CLI invocation
	}
	await program.parseAsync(commandArgs, { from: "user" }).catch(handleError);
})();
