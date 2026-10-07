#!/usr/bin/env node
import { Console } from "node:console";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { Command, Help, Option } from "commander";
import { AGENT_TYPE_HELP_LABEL, SKILL_AGENT_TYPE_HELP_LABEL } from "./adapters/registry.js";
import { registerServeCommand } from "./commands/serve-cli.js";
import { loadAuthTokenFile } from "./lib/auth-token-file.js";
import { parsePositiveInteger } from "./lib/cli-options.js";
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

function collectCsvValues(value: string, prev: string[] = []): string[] {
	const values = value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	return prev.concat(values);
}

function collectValues(value: string, prev: string[] = []): string[] {
	return prev.concat(value);
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

// ─────────────────────────────────────────────────────────────
// deploy
// ─────────────────────────────────────────────────────────────
program
	.command("deploy")
	.description("Create a Cloud Agent with an interactive, payment-aware wizard")
	.option("--runtime <runtime>", "Runtime: hermes or openclaw")
	.option("--provider <provider>", "AI provider: managed, unmanaged, or an exact saved provider ID")
	.option(
		"--model <model>",
		"Primary model id (required when a saved provider has no unique default)",
	)
	.option("--compute <tier>", "Compute: basic or performance")
	.option("--term <months>", "Billing term for paid compute: 1 or 12")
	.option("--payment <method>", "Paid compute payment: wallet or card")
	.option("--name <name>", "Agent display name")
	.option("--language <code>", "Language code or default")
	.option("--timezone <timezone>", "IANA timezone or empty for runtime default")
	.option(
		"--request-id <uuid>",
		"Stable UUID for safe retries (required for every non-interactive deploy)",
	)
	.option("-y, --yes", "Confirm the Cloud Agent and any exact wallet debit")
	.option("--no-wait", "Return after the server accepts the request")
	.option("--no-open", "Print secure card checkout without opening a browser")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi deploy
  $ clawdi deploy --runtime hermes --provider managed --model <id> --compute basic --request-id <uuid> --yes --json
  # Native saved provider: choose models inside the agent
  $ clawdi deploy --provider <saved-provider-id> --compute basic --request-id <uuid> --yes --json
  # Custom saved provider: select its model
  $ clawdi deploy --provider <saved-provider-id> --model <id> --compute basic --request-id <uuid> --yes --json
  $ clawdi deploy --compute performance --term 12 --payment wallet --request-id <uuid> --yes --json
  $ clawdi deploy --compute performance --payment card --request-id <uuid> --yes --json

Card payment uses secure checkout in your browser. Reuse --request-id to recover
the same deploy attempt. Every non-interactive deploy requires it before
any create or checkout mutation. No provider secrets are accepted as flags.`,
	)
	.action(async (opts) => {
		const { deployCommand } = await import("./commands/deploy.js");
		await deployCommand(opts);
	});

// ─────────────────────────────────────────────────────────────
// auth
// ─────────────────────────────────────────────────────────────
const authCmd = program.command("auth").description("Sign in to Clawdi");

authCmd
	.command("login")
	.description("Sign in through your browser")
	.option(
		"--manual",
		"Paste an existing API key; new keys cannot be created. Use `clawdi auth login` (`--no-open` on a server)",
	)
	.option("--no-open", "Print the sign-in link and code without opening a browser")
	.addOption(new Option("--desktop").hideHelp())
	.addOption(new Option("--force").hideHelp())
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi auth login\n  $ clawdi auth login --no-open\n  $ clawdi auth login --manual",
	)
	.action(
		async (opts: { manual?: boolean; open?: boolean; desktop?: boolean; force?: boolean }) => {
			const { authLogin, authLoginDesktop } = await import("./commands/auth.js");
			if (opts.desktop) {
				if (opts.manual || opts.open === false) {
					throw new Error("Desktop sign-in does not accept interactive sign-in options.");
				}
				await authLoginDesktop({ force: opts.force });
				return;
			}
			if (opts.force) throw new Error("--force is only available for Desktop sign-in.");
			await authLogin(opts);
		},
	);

authCmd
	.command("complete")
	.description("Resume waiting for a pending sign-in")
	.action(async () => {
		const { authComplete } = await import("./commands/auth.js");
		await authComplete();
	});

authCmd
	.command("desktop-session", { hidden: true })
	.description("Create a short-lived desktop dashboard session")
	.option("--json", "Output as JSON")
	.action(async () => {
		const { authDesktopSessionMachine } = await import("./commands/auth.js");
		await authDesktopSessionMachine();
	});

authCmd
	.command("logout")
	.description("Remove local credentials")
	.action(async () => {
		const { authLogout } = await import("./commands/auth.js");
		await authLogout();
	});

authCmd
	.command("status")
	.description("Show credential source without printing secrets")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { authStatus } = await import("./commands/auth.js");
		await authStatus(opts);
	});

// ─────────────────────────────────────────────────────────────
// status
// ─────────────────────────────────────────────────────────────
program
	.command("status")
	.description("Show current auth and module activity")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExamples:\n  $ clawdi status\n  $ clawdi status --json")
	.action(async (opts) => {
		const { status } = await import("./commands/status.js");
		await status(opts);
	});

// ─────────────────────────────────────────────────────────────
// wallet
// ─────────────────────────────────────────────────────────────
const walletCmd = program.command("wallet").description("Inspect Clawdi wallet");

walletCmd
	.command("status")
	.description("Show authenticated wallet balance, binding, and USDC funding readiness")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { runWalletStatusCommand } = await import("./commands/wallet.js");
		await runWalletStatusCommand(opts);
	});

walletCmd
	.command("transactions")
	.description("List wallet transactions")
	.option(
		"--limit <n>",
		"Maximum transactions to show (default: API default)",
		parsePositiveInteger,
	)
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi wallet transactions --limit 20 --json")
	.action(async (opts) => {
		const { walletTransactionsCommand } = await import("./commands/wallet.js");
		await walletTransactionsCommand(opts);
	});

walletCmd
	.command("usage")
	.description("Show usage for the API reporting period")
	.option("--days <n>", "Reporting period in days (default: API default)", parsePositiveInteger)
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi wallet usage --days 7 --json")
	.action(async (opts) => {
		const { walletUsageCommand } = await import("./commands/wallet.js");
		await walletUsageCommand(opts);
	});

walletCmd
	.command("portal")
	.description("Print the web billing URL")
	.addHelpText("after", "\nExample:\n  $ clawdi wallet portal")
	.action(async () => {
		const { walletPortalCommand } = await import("./commands/wallet.js");
		await walletPortalCommand();
	});

// ─────────────────────────────────────────────────────────────
// config
// ─────────────────────────────────────────────────────────────
const configCmd = program
	.command("config")
	.description("Read or write CLI configuration (~/.clawdi/config.json)");

configCmd
	.command("list")
	.description("Show effective values and their sources")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { configList } = await import("./commands/config.js");
		configList(opts);
	});

configCmd
	.command("paths")
	.description("Show local and hosted runtime paths used by the CLI")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { configPaths } = await import("./commands/config.js");
		configPaths(opts);
	});

configCmd
	.command("get <key>")
	.description("Print the effective value for a key")
	.action(async (key) => {
		const { configGet } = await import("./commands/config.js");
		configGet(key);
	});

configCmd
	.command("set <key> <value>")
	.description("Persist a config value to disk")
	.action(async (key, value) => {
		const { configSet } = await import("./commands/config.js");
		configSet(key, value);
	});

configCmd
	.command("unset <key>")
	.description("Remove a config key from disk")
	.action(async (key) => {
		const { configUnset } = await import("./commands/config.js");
		configUnset(key);
	});

// ─────────────────────────────────────────────────────────────
// setup
// ─────────────────────────────────────────────────────────────
program
	.command("setup")
	.description("Detect installed agents, register this machine, and install daemons")
	.option("--agent <type>", `Agent type (${AGENT_TYPE_HELP_LABEL})`)
	.option(
		"--vault-workspace <path>",
		"Bind this agent to an explicit vault workspace (requires --agent)",
	)
	.option(
		"--vault-native-agent <id>",
		"Select the official OpenClaw agent whose workspace supplies vault files",
	)
	.option("-y, --yes", "Register every detected agent without prompting")
	.option("--no-daemon", "Skip installing/starting background sync daemons")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi setup\n  $ clawdi setup --yes\n  $ clawdi setup --agent claude_code\n  $ clawdi setup --no-daemon",
	)
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const { setup } = await import("./commands/setup.js");
		await setup(opts);
	});

program
	.command("teardown")
	.description("Reverse setup: remove env file, bundled skill, and MCP entry")
	.option("--agent <type>", `Tear down a single agent (${AGENT_TYPE_HELP_LABEL})`)
	.option("--all", "Tear down every registered agent")
	.option("--keep-skill", "Don't remove the bundled clawdi skill from the agent")
	.option("--keep-mcp", "Don't remove the MCP server registration")
	.option("-y, --yes", "Skip the confirmation prompt")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi teardown --agent claude_code
  $ clawdi teardown --all --yes
  $ clawdi teardown --agent hermes --keep-skill

Non-interactive teardown without --yes is deprecated; --yes will be required starting in 0.16.`,
	)
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const { teardown } = await import("./commands/teardown.js");
		await teardown(opts);
	});

// ─────────────────────────────────────────────────────────────
// push / pull (replaces `sync up` / `sync down`)
// ─────────────────────────────────────────────────────────────
program
	.command("push")
	.description("Push local data (sessions, skills) to the cloud")
	.option(
		"--modules <modules>",
		"Narrow to specific modules (comma-separated: sessions,skills); default: all",
	)
	.option(
		"--project <path>",
		"Push sessions from a specific local project path (default: current directory)",
	)
	.option(
		"--exclude-project <path>",
		"Exclude a project path (repeatable, can't be combined with --project)",
		(value: string, prev: string[] = []) => prev.concat(value),
		[] as string[],
	)
	.option(
		"--all",
		"Push everything: every module, every registered agent, every project (each axis still narrowable via --modules / --agent / --project)",
	)
	.option("--agent <type>", `Narrow to one agent (${AGENT_TYPE_HELP_LABEL})`)
	.option("--all-agents", "Push from every registered agent on this machine (implied by --all)")
	.option("--dry-run", "Preview without uploading")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi push --all                      Push everything (every agent, project, module)
  $ clawdi push                            Push cwd project for the registered agent (or all of them if multiple)
  $ clawdi push --modules skills           Push only skills (cwd project, registered agent(s))
  $ clawdi push --agent claude_code --dry-run
  $ clawdi push --all --json              Output clawdi.push.v1 with per-agent counts, totals, and errors
  $ clawdi push --all --project ~/foo      Push every module / every agent for one specific project
  $ clawdi push --all --exclude-project ~/scratch`,
	)
	.action(async (opts) => {
		const { push } = await import("./commands/push.js");
		await push(opts);
	});

program
	.command("pull")
	.description(
		"Mirror sessions, or explicitly import skills from a Clawdi-owned workspace or personal project",
	)
	.option(
		"--modules <modules>",
		"Narrow to specific modules (comma-separated: skills,sessions). Default: all.",
	)
	.option(
		"-p, --project <id-or-slug>",
		"Import skills from an explicit Custom/personal project (agent workspaces are rejected)",
	)
	.option("--agent <type>", `Narrow to one agent (${AGENT_TYPE_HELP_LABEL})`)
	.option(
		"--all",
		"Pull everything: every module, every registered agent (still narrowable via --modules / --agent)",
	)
	.option("--all-agents", "Pull for every registered agent on this machine (implied by --all)")
	.option("--dry-run", "Preview session mirrors or explicit skill imports without writing locally")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi pull --all                    Mirror sessions for every registered agent
  $ clawdi pull                          Mirror sessions for the registered agent(s)
  $ clawdi pull --modules sessions
  $ clawdi pull --agent claude_code --dry-run
  $ clawdi pull --all --json              Output clawdi.pull.v1 with per-agent counts, totals, and errors
  $ clawdi pull --modules skills --project @alice/engineering --agent codex`,
	)
	.action(async (opts) => {
		const { pull } = await import("./commands/pull.js");
		await pull(opts);
	});

// ─────────────────────────────────────────────────────────────
// serve (daemon)
// ─────────────────────────────────────────────────────────────
// `serve` command tree lives in its own module so the test can
// import the same registration the CLI uses (instead of mocking a
// parallel tree that drifts).
registerServeCommand(program);

// ─────────────────────────────────────────────────────────────
// ai-provider
// ─────────────────────────────────────────────────────────────
const aiProviderCmd = program.command("ai-provider").description("Manage AI providers");

aiProviderCmd
	.command("list")
	.description("List Cloud and local AI providers")
	.addHelpText("after", "\nExample:\n  $ clawdi ai-provider list --json")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const { aiProviderListCommand } = await import("./commands/ai-provider.js");
		await aiProviderListCommand(opts);
	});

aiProviderCmd
	.command("add <provider-id>")
	.description("Add an AI provider to the local provider catalog")
	.requiredOption("--type <type>", "Provider type")
	.option("--label <label>", "Display label")
	.option("--base-url <url>", "Provider base URL")
	.option("--default-model <model>", "Model id to add to the provider catalog")
	.option("--api-mode <mode>", "Provider API mode")
	.requiredOption("--auth <auth>", "Auth: env:<NAME>, clawdi://..., agent:codex/<profile>, or none")
	.option("--agent-env <name>", "Env var name the target agent process should read")
	.option(
		"--capability <name>",
		"Capability to mark true (repeatable or comma-separated)",
		collectValues,
		[],
	)
	.option("--set-default", "Set as the default chat provider")
	.option("--replace", "Replace an existing provider with the same id")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi ai-provider add openai-main --type openai --default-model gpt-5.2 --auth env:OPENAI_API_KEY
  $ clawdi ai-provider add local --type custom_openai_compatible --base-url http://127.0.0.1:1234/v1 --api-mode openai_chat --auth none`,
	)
	.action(async (providerId: string, opts) => {
		const { aiProviderAddCommand } = await import("./commands/ai-provider.js");
		await aiProviderAddCommand(providerId, opts);
	});

aiProviderCmd
	.command("edit <provider-id>")
	.description("Edit a Cloud or local AI provider")
	.addHelpText("after", "\nExample:\n  $ clawdi ai-provider edit openai-main --label Main --json")
	.option("--type <type>", "Provider type")
	.option("--label <label>", "Display label")
	.option("--base-url <url>", "Provider base URL")
	.option("--default-model <model>", "Model id to add to the provider catalog")
	.option("--api-mode <mode>", "Provider API mode")
	.option("--auth <auth>", "Auth: env:<NAME>, clawdi://..., agent:codex/<profile>, or none")
	.option("--agent-env <name>", "Env var name the target agent process should read")
	.option(
		"--capability <name>",
		"Capability to mark true (repeatable or comma-separated)",
		collectValues,
		[],
	)
	.option("--set-default", "Set as the default chat provider")
	.option("--json", "Output as JSON")
	.action(async (providerId: string, opts) => {
		const { aiProviderEditCommand } = await import("./commands/ai-provider.js");
		await aiProviderEditCommand(providerId, opts);
	});

aiProviderCmd
	.command("remove <provider-id>")
	.alias("rm")
	.description("Remove an AI provider")
	.option("--force", "Remove even if defaults reference it")
	.option("-y, --yes", "Skip the interactive confirmation prompt")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi ai-provider remove <provider-id> --yes")
	.action(async (providerId: string, opts) => {
		const { aiProviderRemoveCommand } = await import("./commands/ai-provider.js");
		await aiProviderRemoveCommand(providerId, opts);
	});

aiProviderCmd
	.command("validate [provider-id]")
	.description("Validate the AI provider catalog")
	.option("--allow-no-auth-public", "Allow no-auth providers on public URLs")
	.option("--json", "Output as JSON")
	.action(async (providerId: string | undefined, opts) => {
		const { aiProviderValidateCommand } = await import("./commands/ai-provider.js");
		await aiProviderValidateCommand(providerId, opts);
	});

aiProviderCmd
	.command("test <provider-id>")
	.description("Check provider config and auth availability")
	.option("--model <model>", "Model to validate against when a provider-specific probe supports it")
	.option("--timeout <seconds>", "Provider probe timeout in seconds", parsePositiveInteger, 10)
	.option("--live", "Also run a direct provider metadata probe")
	.option("--probe", "Deprecated alias for --live")
	.option("--no-probe", "Compatibility flag; live probes are disabled unless --live is passed")
	.option("--json", "Output as JSON")
	.action(async (providerId: string, opts) => {
		const { aiProviderTestCommand } = await import("./commands/ai-provider.js");
		await aiProviderTestCommand(providerId, opts);
	});

aiProviderCmd
	.command("connect <provider-id>")
	.description("Connect provider auth through an OAuth/device-code flow")
	.option("--method <method>", "Connect method", "oauth")
	.option("--tool <tool>", "Tool sign-in profile to connect, currently codex")
	.option("--callback <mode>", "OAuth callback mode: loopback or manual")
	.option("--redirect-uri <uri>", "Override OAuth redirect URI for manual callback mode")
	.option("--timeout <seconds>", "Seconds to wait for loopback callback", parsePositiveInteger, 600)
	.option("--no-open", "Do not open the browser automatically")
	.option("--dry-run", "Show the OAuth start request without running it")
	.option("--json", "Output as JSON")
	.action(async (providerId: string, opts) => {
		const { aiProviderConnectCommand } = await import("./commands/ai-provider.js");
		await aiProviderConnectCommand(providerId, opts);
	});

aiProviderCmd
	.command("complete-oauth <provider-id>")
	.description("Complete AI provider OAuth with a pasted redirect URL or code/state")
	.option("--redirect-url <url>", "Full OAuth redirect URL containing code and state")
	.option("--code <code>", "OAuth authorization code")
	.option("--state <state>", "OAuth state returned by connect")
	.option("--redirect-uri <uri>", "Redirect URI used for the OAuth start request")
	.option("--json", "Output as JSON")
	.action(async (providerId: string, opts) => {
		const { aiProviderCompleteOAuthCommand } = await import("./commands/ai-provider.js");
		await aiProviderCompleteOAuthCommand(providerId, opts);
	});

aiProviderCmd
	.command("import-auth <provider-id>")
	.description("Import a local auth profile and bind it to an AI provider")
	.option("--tool <tool>", "Tool profile to import, currently codex")
	.option("--profile <name>", "Profile name", "default")
	.option("--source <source>", "Credential source: file or keychain", "file")
	.option("--from <path>", "Credential file to import")
	.option("--to <path>", "Materialization target path to store with the profile")
	.option("--keychain-service <service>", "macOS Keychain service name for --source keychain")
	.option("--keychain-account <account>", "macOS Keychain account name for --source keychain")
	.option("-y, --yes", "Skip confirmation (required in a non-interactive shell)")
	.option("--dry-run", "Show what would be imported without storing anything")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi ai-provider import-auth openai-codex --tool codex --yes",
	)
	.action(async (providerId: string, opts) => {
		const { aiProviderImportAuthCommand } = await import("./commands/ai-provider.js");
		await aiProviderImportAuthCommand(providerId, opts);
	});

aiProviderCmd
	.command("export")
	.description("Export provider catalog metadata and refs")
	.option("--out <file>", "Write to a file instead of stdout")
	.option("--include-secrets", "Include encrypted env-backed secrets in the export")
	.option("--secret-passphrase", "Encrypt included secrets with a passphrase from env")
	.option(
		"--secret-passphrase-env <name>",
		"Env var holding the encrypted secret export passphrase",
		"CLAWDI_SECRET_EXPORT_PASSPHRASE",
	)
	.action(async (opts) => {
		const { aiProviderExportCommand } = await import("./commands/ai-provider.js");
		await aiProviderExportCommand(opts);
	});

aiProviderCmd
	.command("import [file]")
	.description("Import and merge a provider catalog file")
	.option("--from-hermes <path>", "Import providers from a Hermes config.yaml")
	.option("--from-openclaw <path>", "Import providers from an OpenClaw projection JSON")
	.option("--import-secrets <target>", "Import encrypted secrets to a target, currently env-file")
	.option("--out <file>", "Output path for --import-secrets env-file")
	.option(
		"--secret-passphrase-env <name>",
		"Env var holding the encrypted secret import passphrase",
		"CLAWDI_SECRET_EXPORT_PASSPHRASE",
	)
	.option("--replace", "Replace existing providers with matching ids")
	.option("--json", "Output as JSON")
	.action(async (file: string | undefined, opts) => {
		const { aiProviderImportCommand } = await import("./commands/ai-provider.js");
		await aiProviderImportCommand(file, opts);
	});

// ─────────────────────────────────────────────────────────────
// channels
// ─────────────────────────────────────────────────────────────
const channelCmd = program
	.command("channel")
	.alias("bot")
	.description("Manage channel bots and pair external chats to agents");

channelCmd
	.command("unpair <channel-id>")
	.description("Unpair a chat from a channel")
	.requiredOption("--binding <binding-id>", "Chat binding UUID to unpair")
	.option("-y, --yes", "Confirm unpairing the chat")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi channel unpair <channel-id> --binding <binding-id> --yes --json",
	)
	.action(async (id: string, opts) => {
		const { channelUnpairCommand } = await import("./commands/channel.js");
		await channelUnpairCommand(id, opts);
	});

channelCmd
	.command("unlink <channel-id>")
	.description("Unlink an agent from a channel")
	.requiredOption("--link <link-id>", "Agent link UUID to unlink")
	.option("-y, --yes", "Confirm unlinking the agent")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi channel unlink <channel-id> --link <link-id> --yes --json",
	)
	.action(async (id: string, opts) => {
		const { channelUnlinkCommand } = await import("./commands/channel.js");
		await channelUnlinkCommand(id, opts);
	});

channelCmd
	.command("list")
	.description("List your private channel bots")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { channelListCommand } = await import("./commands/channel.js");
		await channelListCommand(opts);
	});

channelCmd
	.command("available")
	.description("List available channel bots")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { channelAvailableCommand } = await import("./commands/channel.js");
		await channelAvailableCommand(opts);
	});

channelCmd
	.command("get <channel-id>")
	.description("Show channel bot details")
	.option("--json", "Output as JSON")
	.action(async (channelId: string, opts: { json?: boolean }) => {
		const { channelGetCommand } = await import("./commands/channel.js");
		await channelGetCommand(channelId, opts);
	});

channelCmd
	.command("create <provider> <name>")
	.description("Create a private channel bot")
	.option("--agent <agent-id>", "Create an initial bot-agent link")
	.option("--provider-token <token>", "Provider token or upstream credential")
	.option("--provider-token-env <name>", "Read provider token from an env var")
	.option("--config <json>", "Provider config JSON object")
	.option("--secret <name=value>", "Encrypted provider secret; repeatable", collectValues)
	.option(
		"--secret-env <name=env>",
		"Encrypted provider secret read from an env var; repeatable",
		collectValues,
	)
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExample:\n  $ TELEGRAM_BOT_TOKEN=123:abc clawdi channel create telegram ops-bot --agent <agent-id> --provider-token-env TELEGRAM_BOT_TOKEN",
	)
	.action(async (provider: string, name: string, opts) => {
		const { channelCreateCommand } = await import("./commands/channel.js");
		await channelCreateCommand(provider, name, opts);
	});

channelCmd
	.command("links <channel-id>")
	.description("List your bot-agent links for a channel")
	.option("--json", "Output as JSON")
	.action(async (channelId: string, opts: { json?: boolean }) => {
		const { channelLinksCommand } = await import("./commands/channel.js");
		await channelLinksCommand(channelId, opts);
	});

channelCmd
	.command("link <channel-id>")
	.description("Link an accessible bot to one of your agents")
	.requiredOption("--agent <agent-id>", "Target agent id")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi channel link <channel-id> --agent <agent-id>")
	.action(async (channelId: string, opts) => {
		const { channelLinkCommand } = await import("./commands/channel.js");
		await channelLinkCommand(channelId, opts);
	});

channelCmd
	.command("rotate-token <channel-id>")
	.description("Rotate the agent SDK token for one of your bot-agent links")
	.requiredOption("--link <link-id>", "Bot-agent link id")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi channel rotate-token <channel-id> --link <link-id>")
	.action(async (channelId: string, opts) => {
		const { channelRotateTokenCommand } = await import("./commands/channel.js");
		await channelRotateTokenCommand(channelId, opts);
	});

channelCmd
	.command("pair-code <channel-id>")
	.description("Create a one-time code to pair an external chat to an agent link")
	.option("--agent <agent-id>", "Create or reuse a link for this agent")
	.option("--link <link-id>", "Use an existing bot-agent link")
	.option("--ttl <seconds>", "Pair code TTL in seconds", parsePositiveInteger, 300)
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi channel pair-code <channel-id> --agent <agent-id>\n  $ clawdi channel pair-code <channel-id> --link <link-id>",
	)
	.action(async (channelId: string, opts) => {
		const { channelPairCodeCommand } = await import("./commands/channel.js");
		await channelPairCodeCommand(channelId, opts);
	});

channelCmd
	.command("send <channel-id>")
	.description("Queue an outbound message to a paired chat or explicit chat id")
	.option("--binding <binding-id>", "Paired chat binding id")
	.option("--chat <external-chat-id>", "External provider chat id")
	.requiredOption("--text <text>", "Message text")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		'\nExamples:\n  $ clawdi channel send <channel-id> --binding <binding-id> --text "deploy done"\n  $ clawdi channel send <channel-id> --chat <chat-id> --text "hello" --json',
	)
	.action(async (channelId: string, opts) => {
		const { channelSendCommand } = await import("./commands/channel.js");
		await channelSendCommand(channelId, opts);
	});

channelCmd
	.command("bindings <channel-id>")
	.description("List your paired external chats for a channel")
	.option("--json", "Output as JSON")
	.action(async (channelId: string, opts: { json?: boolean }) => {
		const { channelBindingsCommand } = await import("./commands/channel.js");
		await channelBindingsCommand(channelId, opts);
	});

channelCmd
	.command("sync-commands <channel-id>")
	.description("Sync provider slash commands for one of your private bots")
	.option("--guild <guild-id>", "Discord guild id for guild-scoped command sync")
	.option("--commands <json>", "Command spec JSON array; defaults to clawdi_pair and clawdi_unpair")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi channel sync-commands <channel-id>\n  $ clawdi channel sync-commands <channel-id> --guild <discord-guild-id>",
	)
	.action(async (channelId: string, opts) => {
		const { channelSyncCommandsCommand } = await import("./commands/channel.js");
		await channelSyncCommandsCommand(channelId, opts);
	});

channelCmd
	.command("delete <channel-id>")
	.description("Archive one of your private channel bots")
	.option("-y, --yes", "Confirm deletion without prompting")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi channel delete <channel-id> --yes")
	.action(async (channelId: string, opts: { yes?: boolean; json?: boolean }) => {
		const { channelDeleteCommand } = await import("./commands/channel.js");
		await channelDeleteCommand(channelId, opts);
	});

// ─────────────────────────────────────────────────────────────
// managed runtime
// ─────────────────────────────────────────────────────────────
const runtimeCmd = program
	.command("runtime", { hidden: true })
	.description("Managed Hosted runtime control plane");

runtimeCmd
	.command("prepare", { hidden: true })
	.description("Prepare anonymous software-only runtime data without Cloud identity")
	.requiredOption("--spec <path>", "Strict preinstallation specification")
	.requiredOption("--installer <path>", "SHA256-verified official installer")
	.requiredOption("--cli-archive <path>", "Integrity-verified npm archive of this CLI release")
	.action(async (opts: { spec: string; installer: string; cliArchive: string }) => {
		const { readFileSync } = await import("node:fs");
		const { prepareRuntimePreinstallation } = await import("./runtime/preinstallation.js");
		const { getRuntimePaths } = await import("./runtime/paths.js");
		if (process.getuid?.() !== 0) throw new Error("anonymous preparation requires root");
		Object.assign(process.env, {
			CLAWDI_RUNTIME_MODE: "hosted",
			CLAWDI_RUNTIME_USER: "clawdi",
			CLAWDI_RUNTIME_HOME: "/home/clawdi",
		});
		console.log(
			JSON.stringify(
				prepareRuntimePreinstallation(JSON.parse(readFileSync(opts.spec, "utf8")), opts.installer, {
					hosted: { paths: getRuntimePaths({ mode: "hosted" }), cliArchive: opts.cliArchive },
				}),
			),
		);
	});

runtimeCmd
	.command("warm", { hidden: true })
	.description("Experimental: start tenant-independent services in an unclaimed pool instance")
	.option("--runtime <runtime>", "openclaw or hermes", "openclaw")
	.action(async (opts: { runtime: string }) => {
		const { getRuntimePaths } = await import("./runtime/paths.js");
		if (process.getuid?.() !== 0) throw new Error("runtime warm requires root");
		const paths = getRuntimePaths({ mode: "hosted" });
		if (opts.runtime === "hermes") {
			const { warmHostedHermesRuntime } = await import("./runtime/runtime-warm-hermes.js");
			await warmHostedHermesRuntime(paths);
		} else if (opts.runtime === "openclaw") {
			const { warmHostedOpenClawRuntime } = await import("./runtime/runtime-warm.js");
			await warmHostedOpenClawRuntime(paths);
		} else {
			throw new Error(`runtime warm does not support ${opts.runtime}`);
		}
	});

runtimeCmd
	.command("init", { hidden: true })
	.description("Converge a hosted runtime from controller desired state")
	.option("--non-interactive", "Required for hosted boot; never prompt")
	.option("--json", "Output as JSON")
	.action(async (opts: { nonInteractive?: boolean; json?: boolean }) => {
		const { runtimeInit } = await import("./commands/runtime.js");
		await runtimeInit(opts);
	});

runtimeCmd
	.command("watch", { hidden: true })
	.description("Watch hosted runtime desired state and apply live changes")
	.option("--interval-ms <ms>", "Polling interval in milliseconds")
	.option("--self-heal-ms <ms>", "Maximum interval before forcing a full manifest fetch")
	.option("--once", "Run one watch iteration and exit")
	.option("--json", "Output as JSON")
	.action(
		async (opts: { intervalMs?: string; selfHealMs?: string; once?: boolean; json?: boolean }) => {
			const { runtimeWatch } = await import("./commands/runtime.js");
			await runtimeWatch(opts);
		},
	);

runtimeCmd
	.command("provider-handoff", { hidden: true })
	.description("Apply an explicitly authorized provider identity journal CAS")
	.requiredOption("--handoff-id <id>", "Current Cloud handoff receipt ID")
	.action(async (opts: { handoffId: string }) => {
		const { providerIdentityHandoff } = await import("./runtime/provider-handoff.js");
		await providerIdentityHandoff(opts.handoffId);
	});

runtimeCmd
	.command("verify", { hidden: true })
	.description("Validate hosted runtime CLI modules and cached manifest")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { runtimeVerify } = await import("./commands/runtime-doctor.js");
		await runtimeVerify(opts);
	});

runtimeCmd
	.command("sidecar", { hidden: true })
	.description("Run the hosted runtime egress sidecar")
	.action(async () => {
		const { runtimeSidecar } = await import("./runtime/egress-sidecar.js");
		await runtimeSidecar();
	});

runtimeCmd
	.command("status", { hidden: true })
	.description("Show managed Hosted runtime boot status")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { runtimeStatus } = await import("./commands/runtime-doctor.js");
		await runtimeStatus(opts);
	});

runtimeCmd
	.command("doctor", { hidden: true })
	.description("Diagnose hosted runtime policy, paths, and last boot state")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { runtimeDoctor } = await import("./commands/runtime-doctor.js");
		await runtimeDoctor(opts);
	});

// ─────────────────────────────────────────────────────────────
// vault
// ─────────────────────────────────────────────────────────────
const vaultCmd = program
	.command("vault")
	.description("Manage secrets")
	.addHelpText(
		"after",
		`
Scope:
  Vaults are account-level key bundles. Projects attach to a vault to use the
  same shared key set. set/import update the vault for every attached project.
  rm deletes a key from the vault; detach only removes one project's access.
  Key paths are KEY, vault/KEY, or vault/section/KEY.`,
	);

vaultCmd
	.command("request <key>")
	.description("Request a secret through the browser without reading its value")
	.option("--project <id-or-slug>", "Target project (default: your default-write project)")
	.option("--wait", "Wait up to five minutes for the secret to be supplied")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi vault request api-service/OPENAI_API_KEY --project engineering --wait --json",
	)
	.action(async (id: string, opts) => {
		const { vaultRequest } = await import("./commands/vault.js");
		await vaultRequest(id, opts);
	});

vaultCmd
	.command("materialize")
	.alias("pull")
	.description("Bind one vault to a local dotenv file, or pull its saved binding")
	.requiredOption(
		"--out <absolute-path>",
		"Explicit local dotenv target (must be Git-ignored in a repository)",
	)
	.option("--vault <uuid>", "Exact vault identity; required on first pull")
	.option("--project <uuid>", "Exact project attachment; required on first pull")
	.option("--section <name>", "Limit to one section (empty string selects unsectioned keys)")
	.action(async (opts) => {
		const { vaultMaterialize } = await import("./commands/vault-materialize.js");
		await vaultMaterialize(opts);
	});

vaultCmd
	.command("set <key>")
	.description("Store a secret")
	.option(
		"-p, --project <id-or-slug>",
		"Target a specific project (default: your default-write project)",
	)
	.option("--value <value>", "Secret value; use --prompt or --stdin to avoid shell history")
	.option("--stdin", "Read the secret value from stdin")
	.option("--prompt", "Prompt for the secret value without echoing input")
	.option("--allow-empty", "Allow storing an empty secret value intentionally")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault set OPENAI_API_KEY --prompt\n  $ clawdi vault set DEPLOY_KEY --project engineering --prompt\n  $ printf 'secret' | clawdi vault set api-service/env/DEPLOY_KEY --stdin",
	)
	.option("--json", "Output as JSON")
	.action(async (key, opts) => {
		const { vaultSet } = await import("./commands/vault.js");
		await vaultSet(key, {
			...opts,
			project: opts.project,
			value: opts.value,
			stdin: opts.stdin,
			prompt: opts.prompt,
			allowEmpty: opts.allowEmpty,
		});
	});

vaultCmd
	.command("list")
	.description("List stored keys and exact references")
	.option(
		"-p, --project <id-or-slug>",
		"List vaults in a specific project (default: all visible projects)",
	)
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const { vaultList } = await import("./commands/vault.js");
		await vaultList(opts);
	});

vaultCmd
	.command("import <file>")
	.description("Import from .env file")
	.option("-y, --yes", "Skip confirmation (required in a non-interactive shell)")
	.option("--vault <slug>", "Target vault slug", "default")
	.option("--section <name>", "Target vault section")
	.option(
		"-p, --project <id-or-slug>",
		"Target a specific project (default: your default-write project)",
	)
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault import .env.production\n  $ clawdi vault import .env.staging --project engineering --yes\n  $ clawdi vault import --vault prod --section stripe --project engineering --yes .env.stripe",
	)
	.option("--json", "Output as JSON")
	.action(async (file, opts) => {
		const { vaultImport } = await import("./commands/vault.js");
		await vaultImport(file, {
			...opts,
			project: opts.project,
			section: opts.section,
			vault: opts.vault,
		});
	});

vaultCmd
	.command("attach <vault>")
	.description("Make an existing vault available in a project")
	.requiredOption("-p, --project <id-or-slug>", "Project that should use this vault")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault attach providers --project redpill-providers",
	)
	.option("--json", "Output as JSON")
	.action(async (vault, opts) => {
		const { vaultAttach } = await import("./commands/vault.js");
		await vaultAttach(vault, opts);
	});

vaultCmd
	.command("detach <vault>")
	.alias("unlink")
	.description("Remove a project's access to a vault without deleting keys")
	.requiredOption("-p, --project <id-or-slug>", "Project that should stop using this vault")
	.option("-y, --yes", "Confirm detaching the vault")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault detach providers --project env-abc123\n  $ clawdi vault unlink providers --project old-agent",
	)
	.option("--json", "Output as JSON")
	.action(async (vault, opts) => {
		const { vaultDetach } = await import("./commands/vault.js");
		await vaultDetach(vault, opts);
	});

vaultCmd
	.command("rm <key>")
	.alias("delete")
	.description("Delete a key from a vault")
	.option(
		"-p, --project <id-or-slug>",
		"Select the project used to locate the vault (default: your default-write project)",
	)
	.option("-y, --yes", "Skip the confirmation prompt")
	.option(
		"--global",
		"Allow deleting a key from a vault attached to multiple projects (affects every project using it)",
	)
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault rm OPENAI_API_KEY\n  $ clawdi vault delete prod/stripe/SECRET_KEY --project engineering --yes\n  $ clawdi vault rm OPENAI_API_KEY --project engineering --global --yes",
	)
	.option("--json", "Output as JSON")
	.action(async (key, opts) => {
		const { vaultRm } = await import("./commands/vault.js");
		await vaultRm(key, { ...opts, project: opts.project, yes: opts.yes, global: opts.global });
	});

vaultCmd
	.command("resolve <key>")
	.description("Resolve one vault key")
	.option(
		"-p, --project <project>",
		"Project to resolve from (default: your default-write project)",
	)
	.option("-a, --agent <agent-id-or-type>", "Resolve through workspace and linked projects")
	.option(
		"--allow-conflicts",
		"Allow first-match wins for workspace and linked-project vault conflicts",
	)
	.option("--debug", "Show project precedence and skipped matches")
	.option("--dry-run", "Check where the key resolves without printing the plaintext value")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ clawdi vault resolve OPENAI_API_KEY                       # default-write project\n" +
			"  $ clawdi vault resolve OPENAI_API_KEY --project personal --debug\n" +
			"  $ clawdi vault resolve OPENAI_API_KEY --agent <agent-id> --debug\n" +
			"  $ clawdi vault resolve OPENAI_API_KEY --agent codex --allow-conflicts --json",
	)
	.action(async (key, opts) => {
		const { vaultResolveCommand } = await import("./commands/vault-resolve.js");
		await vaultResolveCommand(key, { ...opts, project: opts.project });
	});

program
	.command("read")
	.description("Read one clawdi:// secret reference")
	.argument("<reference>", "Reference to read")
	.option("-p, --project <project>", "Project to resolve from")
	.option("-a, --agent <agent-id-or-type>", "Resolve through workspace and linked projects")
	.option(
		"--allow-conflicts",
		"Allow first-match wins for workspace and linked-project vault conflicts",
	)
	.option("--debug", "Show project precedence without printing secrets in diagnostics")
	.option("--dry-run", "Check the reference without printing the plaintext value")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ clawdi read clawdi://project/<project-id>/vault/prod/section/stripe/field/secret_key\n" +
			"  $ clawdi read clawdi://prod/db/url --project engineering --json",
	)
	.action(async (reference, opts) => {
		const { readCommand } = await import("./commands/read.js");
		await readCommand(reference, { ...opts, project: opts.project });
	});

program
	.command("inject")
	.description("Render clawdi:// references in a template")
	.option("--in <file>", "Input template path, or - for stdin", "-")
	.option("--out <file>", "Output path, or - for stdout", "-")
	.option("--force", "Overwrite an existing output file")
	.option("-p, --project <project>", "Project to resolve from")
	.option("-a, --agent <agent-id-or-type>", "Resolve through workspace and linked projects")
	.option(
		"--allow-conflicts",
		"Allow first-match wins for workspace and linked-project vault conflicts",
	)
	.option("--no-project-folder", "Skip linked-folder project lookup")
	.option("--dry-run", "Show references that would resolve without writing output")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ clawdi inject --dry-run --in .env.clawdi --out .env.local\n" +
			"  $ clawdi inject --force --in .env.clawdi --out .env.local\n" +
			"  $ clawdi inject --in config.template.json --out -",
	)
	.action(async (opts) => {
		const { injectCommand } = await import("./commands/inject.js");
		await injectCommand({ ...opts, project: opts.project });
	});

// ─────────────────────────────────────────────────────────────
// skill
// ─────────────────────────────────────────────────────────────
const skillCmd = program.command("skill").description("Manage skills");

skillCmd
	.command("show <key>")
	.description("Read a skill without importing it")
	.option("-p, --project <id-or-slug>", "Target project (default: your default-write project)")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi skill show my-skill --project engineering --json")
	.action(async (id: string, opts) => {
		const { skillShow } = await import("./commands/skill.js");
		await skillShow(id, opts);
	});

skillCmd
	.command("list")
	.description("List uploaded skills")
	.option(
		"-p, --project <id-or-slug>",
		"List skills in a specific project (default: all visible projects)",
	)
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const { skillList } = await import("./commands/skill.js");
		await skillList(opts);
	});

skillCmd
	.command("add <path>")
	.description("Upload a skill directory or single .md file")
	.option("-a, --agent <type>", `Upload to an agent workspace (${SKILL_AGENT_TYPE_HELP_LABEL})`)
	.option(
		"-p, --project <id-or-slug>",
		"Upload to an explicit project (UUID, slug, or name); can't be combined with --agent",
	)
	.option("-y, --yes", "Skip the confirmation prompt")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi skill add ./my-skill --project engineering   # Project\n  $ clawdi skill add ./my-skill --agent codex            # Agent workspace",
	)
	.option("--json", "Output as JSON")
	.action(async (path, opts) => {
		const { skillAdd } = await import("./commands/skill.js");
		await skillAdd(path, { ...opts, project: opts.project });
	});

skillCmd
	.command("install <repo>")
	.description("Install a skill from GitHub (owner/repo or owner/repo/path)")
	.option("-a, --agent <type>", `Install to a single agent (${SKILL_AGENT_TYPE_HELP_LABEL})`)
	.option(
		"-p, --project <id-or-slug>",
		"Install into an explicit owned project (UUID, slug, or name); can't be combined with --agent",
	)
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi skill install vercel-labs/agent-skills
  $ clawdi skill install owner/repo/path/to/skill
  $ clawdi skill install owner/repo --agent claude_code
  $ clawdi skill install owner/repo --project engineering`,
	)
	.option("--json", "Output as JSON")
	.action(async (repo, opts) => {
		const { skillInstall } = await import("./commands/skill.js");
		await skillInstall(repo, opts);
	});

skillCmd
	.command("rm <key>")
	.description("Remove a skill from the cloud")
	.option("-y, --yes", "Skip the interactive confirmation prompt")
	.option("-a, --agent <type>", `Remove from an agent workspace (${SKILL_AGENT_TYPE_HELP_LABEL})`)
	.option(
		"-p, --project <id-or-slug>",
		"Remove from an explicit owned project (UUID, slug, or name); can't be combined with --agent",
	)
	.addHelpText("after", "\nExample:\n  $ clawdi skill rm my-skill --yes")
	.option("--json", "Output as JSON")
	.action(async (key, opts) => {
		const { skillRm } = await import("./commands/skill.js");
		await skillRm(key, opts);
	});

skillCmd
	.command("init [name]")
	.description("Scaffold a new SKILL.md template in the current or named directory")
	.addHelpText("after", "\nExamples:\n  $ clawdi skill init\n  $ clawdi skill init my-skill")
	.action(async (name) => {
		const { skillInit } = await import("./commands/skill.js");
		skillInit(name);
	});

// ─────────────────────────────────────────────────────────────
// session
// ─────────────────────────────────────────────────────────────
const sessionCmd = program
	.command("session")
	.description("Inspect local and uploaded agent sessions");

sessionCmd
	.command("list")
	.description("List local agent sessions, or uploaded sessions with --uploaded")
	.option("--uploaded", "List sessions already uploaded to the cloud")
	.option("--agent <type>", `Single agent (${AGENT_TYPE_HELP_LABEL})`)
	.option("--agent-id <uuid>", "Filter uploaded sessions by Cloud Agent UUID")
	.option("--all-agents", "List sessions from every registered agent (default)")
	.option("--project <path>", "Restrict to one project path")
	.option("--all", "List sessions from all projects (default when --project not set)")
	.option("--since <date>", "Only list sessions started after this date")
	.option("--limit <n>", "Cap results", parsePositiveInteger, 100)
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi session list
  $ clawdi session list --json
  $ clawdi session list --agent claude_code --project ~/work/foo
  $ clawdi session list --uploaded --agent-id <agent-uuid> --limit 10 --json`,
	)
	.action(async (opts) => {
		const { sessionList } = await import("./commands/session.js");
		await sessionList(opts);
	});

sessionCmd
	.command("search <query>")
	.description("Search uploaded session summaries, messages, projects, and IDs")
	.option("--agent <type>", "Filter by agent type")
	.option("--since <date>", "Only sessions active after this date")
	.option("--limit <n>", "Cap results (1-200)", parsePositiveInteger, 25)
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		'\nExamples:\n  $ clawdi session search authentication\n  $ clawdi session search "workspace setup" --agent codex --limit 10',
	)
	.action(async (query, opts) => {
		const { sessionSearch } = await import("./commands/session.js");
		await sessionSearch(query, opts);
	});

sessionCmd
	.command("read <session-id>")
	.description("Read one uploaded session and its message content")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi session read <session-id>\n  $ clawdi session read <session-id> --json\n\nUse the cloud session UUID printed by `clawdi session list --uploaded`.",
	)
	.action(async (sessionId, opts) => {
		const { sessionRead } = await import("./commands/session.js");
		await sessionRead(sessionId, opts);
	});

sessionCmd
	.command("rm <session-id>")
	.description("Permanently delete an uploaded session")
	.option("-y, --yes", "Confirm permanent deletion without prompting")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nUse the uploaded session UUID from `clawdi session list --uploaded` or `read`.",
	)
	.action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
		const { sessionRm } = await import("./commands/session.js");
		await sessionRm(id, opts);
	});

sessionCmd
	.command("export <session-id>")
	.description("Export an uploaded session as Markdown to stdout")
	.option("--json", "Output as JSON")
	.action(async (id, opts) => {
		const { sessionExport } = await import("./commands/session.js");
		await sessionExport(id, opts);
	});

sessionCmd
	.command("share <session-id>")
	.description("Publish an immutable public snapshot (user-level auth)")
	.option("-y, --yes", "Confirm public publication without prompting")
	.option("--through <position>", "Include messages through this zero-based position")
	.option("--response <position>", "Share only the assistant response at this zero-based position")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi session share <session-id> --yes\n  $ clawdi session share <session-id> --through 4 --yes --json",
	)
	.action(async (id, opts) => {
		const { sessionShareCreate } = await import("./commands/session.js");
		await sessionShareCreate(id, opts);
	});
sessionCmd
	.command("shares [session-id]")
	.description("List active snapshot and legacy links")
	.option("--page <n>", "Page number", parsePositiveInteger, 1)
	.option("--limit <n>", "Page size (1-100)", parsePositiveInteger, 25)
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi session shares\n  $ clawdi session shares <session-id> --json",
	)
	.action(async (id, opts) => {
		const { sessionShareList } = await import("./commands/session.js");
		await sessionShareList(id, opts);
	});
sessionCmd
	.command("unshare <share-id>")
	.option("--legacy", "Revoke a legacy live link (kind=live in session shares)")
	.option("-y, --yes", "Confirm revocation without prompting")
	.description("Revoke the exact snapshot or legacy link ID from session shares")
	.option("--json", "Output as JSON")
	.action(async (id, opts) => {
		const { sessionShareRevoke } = await import("./commands/session.js");
		await sessionShareRevoke(id, opts);
	});

sessionCmd
	.command("extract <session-id>")
	.description("Extract memories from a session via the cloud's configured LLM")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi session extract a1b2c3d4-...
  $ clawdi session extract a1b2c3d4-... --json
  # Loop the recent 10 sessions (the onboarding skill does this):
  $ clawdi session list --limit 10 --json | \\
      jq -r '.[].id' | \\
      xargs -I{} clawdi session extract {} --json`,
	)
	.action(async (sessionId, opts) => {
		const { sessionExtract } = await import("./commands/session.js");
		await sessionExtract(sessionId, opts);
	});

// ─────────────────────────────────────────────────────────────
// memory
// ─────────────────────────────────────────────────────────────
const memoryCmd = program.command("memory").description("Manage memories");

memoryCmd
	.command("list")
	.description("List memories")
	.option("--json", "Output as JSON")
	.option("--limit <n>", "Max number of memories", parsePositiveInteger)
	.option("--category <cat>", "Filter by category (fact/preference/pattern/decision/context)")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi memory list\n  $ clawdi memory list --category preference --json",
	)
	.action(async (opts) => {
		const { memoryList } = await import("./commands/memory.js");
		await memoryList(opts);
	});

memoryCmd
	.command("search <query>")
	.description("Search memories by text")
	.option("--json", "Output as JSON")
	.option("--limit <n>", "Max number of memories", parsePositiveInteger)
	.option("--category <cat>", "Filter by category")
	.addHelpText(
		"after",
		'\nExamples:\n  $ clawdi memory search redis\n  $ clawdi memory search "typing styles" --limit 5',
	)
	.action(async (query, opts) => {
		const { memorySearch } = await import("./commands/memory.js");
		await memorySearch(query, opts);
	});

memoryCmd
	.command("add <content>")
	.description("Add a memory")
	.option(
		"--category <cat>",
		"One of: fact, preference, pattern, decision, context (default: fact)",
	)
	.addHelpText(
		"after",
		'\nExample:\n  $ clawdi memory add "Prefer concise release notes" --category preference',
	)
	.option("--json", "Output as JSON")
	.action(async (content, opts) => {
		const { memoryAdd } = await import("./commands/memory.js");
		await memoryAdd(content, opts);
	});

memoryCmd
	.command("update <id> <content>")
	.description("Replace exact memory content, preserving metadata; use the full ID")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		'\nExample:\n  $ clawdi memory update <memory-id> "Prefer concise release notes" --json',
	)
	.action(async (id, content, opts) => {
		const { memoryUpdate } = await import("./commands/memory.js");
		await memoryUpdate(id, content, opts);
	});

memoryCmd
	.command("rm <id>")
	.description("Delete a memory")
	.option("-y, --yes", "Skip the interactive confirmation prompt")
	.addHelpText("after", "\nExample:\n  $ clawdi memory rm <id> --yes")
	.option("--json", "Output as JSON")
	.action(async (id, opts) => {
		const { memoryRm } = await import("./commands/memory.js");
		await memoryRm(id, opts);
	});

// ─────────────────────────────────────────────────────────────
// doctor / update
// ─────────────────────────────────────────────────────────────
program
	.command("doctor")
	.description("Diagnose auth, agents, vault, and MCP connectivity")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExamples:\n  $ clawdi doctor\n  $ clawdi doctor --json")
	.action(async (opts) => {
		const { doctor } = await import("./commands/doctor.js");
		await doctor(opts);
	});

program
	.command("capabilities", { hidden: true })
	.description("Show CLI feature surface and hosted policy restrictions")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { capabilitiesCommand } = await import("./commands/capabilities.js");
		await capabilitiesCommand(
			opts,
			program.commands.map((command) => command.name()),
		);
	});

program
	.command("update")
	.description("Install the latest CLI through the current installation owner")
	.option("--check", "Only check for updates, don't install")
	.option(
		"-y, --yes",
		"Install without prompting (required to install from a non-interactive shell)",
	)
	.option("--json", "Output as JSON")
	.addOption(new Option("--background-worker").hideHelp())
	.addOption(new Option("--current-version <version>").hideHelp())
	.addOption(new Option("--channel <channel>").hideHelp())
	.addOption(new Option("--latest <version>").hideHelp())
	.addOption(new Option("--native-identity").hideHelp())
	.addOption(new Option("--native-activate").hideHelp())
	.addOption(new Option("--native-stage <path>").hideHelp())
	.addOption(new Option("--native-prefix <path>").hideHelp())
	.addOption(new Option("--native-version <version>").hideHelp())
	.addOption(new Option("--native-target <target>").hideHelp())
	.addOption(new Option("--native-lock-timeout-ms <milliseconds>").hideHelp())
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi update\n  $ clawdi update --yes\n  $ clawdi update --yes --json\n  $ clawdi update --check --json",
	)
	.action(async (opts) => {
		if (opts.nativeIdentity) {
			const { nativeIdentityOutput } = await import("./lib/native-activation.js");
			console.log(nativeIdentityOutput());
			return;
		}
		if (opts.nativeActivate) {
			const { activateStagedNativeRelease } = await import("./lib/native-activation.js");
			const { isNativeBuildTarget } = await import("./lib/native-release-manifest.js");
			if (
				!opts.nativeStage ||
				!opts.nativePrefix ||
				!opts.nativeVersion ||
				!opts.nativeTarget ||
				!isNativeBuildTarget(opts.nativeTarget)
			) {
				throw new Error("native activation requires a valid stage, prefix, version, and target");
			}
			const timeoutMs =
				opts.nativeLockTimeoutMs === undefined ? undefined : Number(opts.nativeLockTimeoutMs);
			if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
				throw new Error("native activation lock timeout must be a non-negative number");
			}
			let result: Awaited<ReturnType<typeof activateStagedNativeRelease>>;
			try {
				result = await activateStagedNativeRelease(
					{
						stageDir: opts.nativeStage,
						prefix: opts.nativePrefix,
						version: opts.nativeVersion,
						target: opts.nativeTarget,
					},
					timeoutMs === undefined ? undefined : { timeoutMs },
				);
			} catch (error) {
				const { PrivateDirectoryLockTimeoutError } = await import(
					"./lib/private-directory-lock.js"
				);
				if (error instanceof PrivateDirectoryLockTimeoutError) {
					process.exitCode = 75;
					return;
				}
				throw error;
			}
			console.log(result.launcher);
			return;
		}
		const { runBackgroundUpdateWorker, update } = await import("./commands/update.js");
		if (opts.backgroundWorker) {
			if (!opts.currentVersion || !opts.channel) {
				throw new Error("background update worker requires current version and channel");
			}
			const result = await runBackgroundUpdateWorker({
				currentVersion: opts.currentVersion,
				channel: opts.channel,
				latest: opts.latest,
			});
			if (result === "failed") process.exitCode = 1;
			return;
		}
		await update(opts);
	});

// ─────────────────────────────────────────────────────────────
// mcp / run
// ─────────────────────────────────────────────────────────────
program
	.command("mcp")
	.description("Start MCP server (stdio transport, used by agents)")
	.option("--api-url <url>", "Override CLAWDI_API_URL for this MCP process")
	.option("--auth-token-file <path>", "Read CLAWDI_AUTH_TOKEN from an owner-only file")
	.action(async (opts: { apiUrl?: string; authTokenFile?: string }) => {
		const apiUrl = opts.apiUrl?.trim();
		if (apiUrl) process.env.CLAWDI_API_URL = apiUrl;
		loadAuthTokenFile(opts.authTokenFile);
		const { startMcpServer } = await import("./mcp/server.js");
		await startMcpServer();
	});

program
	.command("run")
	.description("Run a command with clawdi:// references resolved")
	.option("-p, --project <id-or-slug>", "Resolve references from an explicit project")
	.option("-a, --agent <agent-id-or-type>", "Resolve through workspace and linked projects")
	.option(
		"--env-file <file>",
		"Load dotenv-like file and resolve clawdi:// references",
		(value, previous: string[]) => [...previous, value],
		[],
	)
	.option("--no-inherit-env", "Do not inherit the parent process environment")
	.option("--all-vault-env", "Legacy mode: inject every vault env value from the selected project")
	.option(
		"--allow-conflicts",
		"Allow first-match wins for workspace and linked-project vault conflicts",
	)
	.option("--no-project-folder", "Skip linked-folder project lookup")
	.option("--dry-run", "Show reference resolution plan without launching the command")
	.addOption(
		new Option(
			"--runtime-service <runtime+service>",
			"Run an internal hosted runtime service",
		).hideHelp(),
	)
	.argument("<command...>", "Command to run")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi project folder link --project engineering
  $ clawdi run --dry-run --env-file .env.clawdi -- npm run dev
  $ clawdi run --env-file .env.clawdi -- npm run dev
  ✓ Resolved 2 clawdi references

  $ clawdi run --project @alice/engineering --env-file .env.clawdi -- npm run dev
  $ clawdi run --all-vault-env -- npm run dev
  $ clawdi run --no-project-folder -- python main.py

Scope resolution:
  Exact clawdi://project/... references carry their own project.
  Otherwise --project wins, then --agent, then linked folder, then default-write project.`,
	)
	.action(async (args, opts) => {
		const { run } = await import("./commands/run.js");
		await run(args, opts);
	});

const projectCmd = program
	.command("project")
	.description("Manage projects, people, invites, links, and shared access")
	.addHelpText(
		"after",
		`
Folder-link workflow:
  $ clawdi project folder link --project engineering
  $ clawdi project folder status
  $ clawdi run -- npm run deploy

Notes:
	  project list shows user-created and shared projects by default.
	  Use project list --include-workspaces to inspect agent workspaces.`,
	);

projectCmd
	.command("create <name>")
	.description("Create a project")
	.option("--slug <slug>", "Optional stable slug (lowercase letters, numbers, hyphens)")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			'  $ clawdi project create "Engineering toolkit"\n' +
			'  $ clawdi project create "Client Alpha" --slug client-alpha --json',
	)
	.action(async (name: string, opts: { slug?: string; json?: boolean }) => {
		const { projectCreateCommand } = await import("./commands/project-create.js");
		await projectCreateCommand(name, opts);
	});

projectCmd
	.command("list")
	.description("List owned projects and projects shared with you")
	.option("--json", "Output as JSON")
	.option("--shared-with-me", "Show only projects shared with you")
	.option("--owned", "Show only projects you own")
	.option("--include-workspaces", "Include agent workspaces")
	.addOption(new Option("--include-envs").hideHelp())
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi project list\n  $ clawdi project list --include-workspaces\n  $ clawdi project list --shared-with-me --json",
	)
	.action(
		async (opts: {
			json?: boolean;
			sharedWithMe?: boolean;
			owned?: boolean;
			includeEnvs?: boolean;
			includeWorkspaces?: boolean;
		}) => {
			const { projectListCommand } = await import("./commands/project-list.js");
			await projectListCommand({
				...opts,
				includeEnvs: opts.includeWorkspaces === true || opts.includeEnvs === true,
			});
		},
	);

projectCmd
	.command("show <project>")
	.description("Show project content, role, owner, and next actions")
	.option("--json", "Output as JSON")
	.action(async (project: string, opts: { json?: boolean }) => {
		const { projectShowCommand } = await import("./commands/project-show.js");
		await projectShowCommand(project, opts);
	});

projectCmd
	.command("rm <project>")
	.description("Archive a project you created")
	.option("-y, --yes", "Confirm archiving without prompting")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi project rm engineering --yes --json")
	.action(async (project: string, opts: { yes?: boolean; json?: boolean }) => {
		const { projectRmCommand } = await import("./commands/project-rm.js");
		await projectRmCommand(project, opts);
	});

const projectFolderCmd = projectCmd
	.command("folder")
	.description("Link local folders to projects for automatic vault env selection");

projectFolderCmd
	.command("link [path]")
	.description("Use this folder with a project")
	.requiredOption("-p, --project <id-or-slug>", "Project UUID, slug, or owner-qualified slug")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi project folder link --project engineering
  $ clawdi project folder link ~/work/client-a --project @alice/engineering`,
	)
	.action(async (path: string | undefined, opts: { project: string }) => {
		const { projectFolderLinkCommand } = await import("./commands/project-folders.js");
		await projectFolderLinkCommand(path, opts);
	});

projectFolderCmd
	.command("unlink [path]")
	.description("Stop using this folder with its linked project")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi project folder unlink
  $ clawdi project folder unlink ~/work/client-a`,
	)
	.action(async (path: string | undefined) => {
		const { projectFolderUnlinkCommand } = await import("./commands/project-folders.js");
		await projectFolderUnlinkCommand(path);
	});

projectFolderCmd
	.command("status [path]")
	.description("Show which project clawdi run will use for a folder")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi project folder status
  $ clawdi project folder status ~/work/client-a`,
	)
	.action(async (path: string | undefined) => {
		const { projectFolderStatusCommand } = await import("./commands/project-folders.js");
		await projectFolderStatusCommand(path);
	});

projectCmd
	.command("share [project]")
	.description("Create a viewer project share link")
	.option("-l, --label <text>", "Optional label shown in the share-links list")
	.option("--json", "Output as JSON")
	.action(async (project: string | undefined, opts: { label?: string; json?: boolean }) => {
		const { projectShareCommand } = await import("./commands/project-share.js");
		await projectShareCommand(project, opts);
	});

projectCmd
	.command("share-links <project>")
	.description("List or revoke viewer project links")
	.option("--revoke <id-or-prefix>", "Revoke a specific link")
	.option("-y, --yes", "Confirm revoking a project share link")
	.option("--json", "Output as JSON")
	.action(async (project: string, opts: { revoke?: string; yes?: boolean; json?: boolean }) => {
		const { projectShareLinksCommand } = await import("./commands/project-share-links.js");
		await projectShareLinksCommand(project, opts);
	});

projectCmd
	.command("invite <project>")
	.description("Invite a person to viewer project access")
	.requiredOption("-e, --email <addr>", "Email address to invite")
	.option("--json", "Output as JSON")
	.action(async (project: string, opts: { email: string; json?: boolean }) => {
		const { projectInviteCommand } = await import("./commands/project-invite.js");
		await projectInviteCommand(project, opts);
	});

projectCmd
	.command("invites <project>")
	.description("List or cancel pending project invites")
	.option("--cancel <id>", "Cancel one of the pending invitations on this project")
	.option("-y, --yes", "Confirm canceling a project invitation")
	.addHelpText(
		"after",
		"\n  Recipient side (listing / accepting / declining invitations addressed to you)\n" +
			"  lives under `clawdi inbox`.",
	)
	.option("--json", "Output as JSON")
	.action(async (project: string, opts: { cancel?: string; yes?: boolean; json?: boolean }) => {
		const { projectInvitesCommand } = await import("./commands/project-invites.js");
		await projectInvitesCommand(project, opts);
	});

projectCmd
	.command("members <project>")
	.description("List or remove people with project access")
	.option("--remove <email-or-user-id>", "Remove one accepted member")
	.option("-y, --yes", "Confirm member removal without prompting")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi project members engineering --remove bob@example.com --yes\n\nNon-interactive removal without --yes is deprecated; --yes will be required starting in 0.16.",
	)
	.action(async (project: string, opts: { remove?: string; json?: boolean; yes?: boolean }) => {
		const { projectMembersCommand } = await import("./commands/project-members.js");
		await projectMembersCommand(project, opts);
	});

projectCmd
	.command("leave <project>")
	.description("Leave a project shared with you")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi project leave @alice-cdbf/engineering")
	.action(async (project: string, opts: { json?: boolean }) => {
		const { projectLeaveCommand } = await import("./commands/project-members.js");
		await projectLeaveCommand(project, opts);
	});

projectCmd
	.command("unshare <project>")
	.description("Owner: revoke links, cancel invites, and remove accepted viewers")
	.option("-y, --yes", "Confirm revoking all project sharing without prompting")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi project unshare engineering --yes\n\nNon-interactive sharing revocation without --yes is deprecated; --yes will be required starting in 0.16.",
	)
	.action(async (project: string, opts: { json?: boolean; yes?: boolean }) => {
		const { projectUnshareCommand } = await import("./commands/project-members.js");
		await projectUnshareCommand(project, opts);
	});

const agentCmd = program.command("agent").description("Manage agents");

agentCmd
	.command("list")
	.description("List your agents and their last activity")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { agentList } = await import("./commands/agent.js");
		await agentList(opts);
	});

agentCmd
	.command("rm <agent-id>")
	.description("Disconnect a local agent or delete a Cloud Agent and its saved data")
	.option("-y, --yes", "Confirm removal without prompting")
	.option("--cancel-subscription", "Cancel the Cloud Agent subscription when deleting")
	.option("--keep-subscription", "Keep the Cloud Agent subscription for a future agent")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nUse the agent UUID printed by `clawdi agent list`. Renewing subscriptions require a choice.\nExample: clawdi agent rm <agent-id> --yes --cancel-subscription --json",
	)
	.action(
		async (
			id: string,
			opts: {
				yes?: boolean;
				json?: boolean;
				cancelSubscription?: boolean;
				keepSubscription?: boolean;
			},
		) => {
			const { agentRm } = await import("./commands/agent.js");
			await agentRm(id, opts);
		},
	);

for (const action of ["start", "stop", "restart"] as const) {
	agentCmd
		.command(`${action} <agent-id>`)
		.description(
			`${action[0]?.toUpperCase()}${action.slice(1)} a Cloud Agent and wait for completion`,
		)
		.option("--json", "Output as JSON")
		.option("--no-wait", "Return when the operation is accepted")
		.addHelpText(
			"after",
			`\nUse the agent UUID printed by \`clawdi agent list\`.\nExample: clawdi agent ${action} <agent-id> --json`,
		)
		.action(async (id: string, opts: { json?: boolean; wait?: boolean }) => {
			const { agentLifecycle } = await import("./commands/agent-lifecycle.js");
			await agentLifecycle(action, id, opts);
		});
}

const agentPluginsCmd = agentCmd.command("plugins").description("Manage Cloud Agent plugins");
agentPluginsCmd
	.command("list <agent-id>")
	.description("List requested plugins and observed convergence")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample: clawdi agent plugins list <agent-id> --json")
	.action(async (id: string, opts: { json?: boolean }) => {
		const { agentPluginsList } = await import("./commands/agent-plugins.js");
		await agentPluginsList(id, opts);
	});
agentPluginsCmd
	.command("install <agent-id> [plugin-name]")
	.description("Request a catalog plugin installation; omit the name for choices")
	.option("--plugin-version <version>", "Exact plugin catalog version")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample: clawdi agent plugins install <agent-id> <plugin-name> --json")
	.action(
		async (
			id: string,
			name: string | undefined,
			opts: { json?: boolean; pluginVersion?: string },
		) => {
			const { agentPluginsInstall } = await import("./commands/agent-plugins.js");
			await agentPluginsInstall(id, name, opts);
		},
	);
agentPluginsCmd
	.command("rm <agent-id> <plugin-name>")
	.description("Request removal of an agent plugin")
	.option("-y, --yes", "Confirm removal without prompting")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample: clawdi agent plugins rm <agent-id> <plugin-name> --yes --json")
	.action(async (id: string, name: string, opts: { json?: boolean; yes?: boolean }) => {
		const { agentPluginsRemove } = await import("./commands/agent-plugins.js");
		await agentPluginsRemove(id, name, opts);
	});

const agentSkillsCmd = agentCmd
	.command("skills")
	.description("Manage remote Cloud Agent skills (not local --agent types)");
agentSkillsCmd
	.command("list <agent-id>")
	.description("List remote desired skills, capabilities and observed convergence")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi agent skills list <agent-id> --json")
	.action(async (id, opts) => {
		const { agentSkillsList } = await import("./commands/agent-skills.js");
		await agentSkillsList(id, opts);
	});
agentSkillsCmd
	.command("read <agent-id> <skill-key>")
	.description("Read remote skill detail using its exact inventory key")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi agent skills read <agent-id> review/SKILL.md")
	.action(async (id, key, opts) => {
		const { agentSkillsRead } = await import("./commands/agent-skills.js");
		await agentSkillsRead(id, key, opts);
	});
agentSkillsCmd
	.command("install <agent-id>")
	.description("Request a public GitHub skill or library reference; inspect list for application")
	.option("--github <repo>", "Public GitHub owner/repo or URL")
	.option("--path <directory>", "Skill directory within the GitHub repository")
	.option("--library <skill-id>", "Library skill UUID")
	.option("--request-id <uuid>", "GitHub mutation idempotency key (generated if omitted)")
	.option(
		"--resource-version <version>",
		"Original resource version for exact replay with --request-id",
	)
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi agent skills install <agent-id> --github owner/repo --path skills/review\n  $ clawdi agent skills install <agent-id> --library <skill-id>",
	)
	.action(async (id, opts) => {
		const { agentSkillsInstall } = await import("./commands/agent-skills.js");
		await agentSkillsInstall(id, opts);
	});
agentSkillsCmd
	.command("rm <agent-id> <skill-key>")
	.description("Request removal by exact remote inventory key; linked/bundled skills are read-only")
	.option("--request-id <uuid>", "GitHub mutation idempotency key (generated if omitted)")
	.option(
		"--resource-version <version>",
		"Original resource version for exact replay with --request-id",
	)
	.option("-y, --yes", "Confirm remote skill removal without prompting")
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi agent skills rm <agent-id> review/SKILL.md --yes")
	.action(async (id, key, opts) => {
		const { agentSkillsRemove } = await import("./commands/agent-skills.js");
		await agentSkillsRemove(id, key, opts);
	});

agentCmd
	.command("detect")
	.description("Detect supported local agents without changing them")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { agentDetectCommand } = await import("./commands/agent-detect.js");
		await agentDetectCommand(opts);
	});

agentCmd
	.command("reconnect [agent-id]")
	.description("Recover a local agent binding without creating a new cloud identity")
	.option("--agent <type>", `Agent type (${AGENT_TYPE_HELP_LABEL})`)
	.option("-y, --yes", "Skip confirmation when the target is unambiguous")
	.option("--confirm-takeover", "Confirm disconnecting a recently active installation")
	.option("--no-daemon", "Skip installing/starting background sync daemons")
	.addOption(new Option("--desktop-list").hideHelp())
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi agent reconnect --agent codex\n  $ clawdi agent reconnect <agent-id>\n  $ clawdi agent reconnect <agent-id> --no-daemon",
	)
	.action(async (agentId: string | undefined, opts) => {
		const { agentReconnect } = await import("./commands/agent-reconnect.js");
		await agentReconnect(agentId, opts);
	});

const agentCredentialsCmd = agentCmd
	.command("credentials")
	.description("Sync local CLI credential profiles");

agentCredentialsCmd
	.command("import <tool>")
	.description("Import a personal local CLI credential profile into Clawdi vault")
	.option("-p, --project <id-or-slug>", "Target a specific project")
	.option("--profile <name>", "Profile name", "default")
	.option("--source <source>", "Credential source: file or keychain", "file")
	.option("--from <path>", "Credential file to import (required for tools without an adapter)")
	.option("--to <path>", "Materialization target path to store with the profile")
	.option("--keychain-service <service>", "macOS Keychain service name for --source keychain")
	.option("--keychain-account <account>", "macOS Keychain account name for --source keychain")
	.option("-y, --yes", "Skip confirmation (required in a non-interactive shell)")
	.option("--dry-run", "Show what would be imported without storing anything")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi agent credentials import claude-code
  $ clawdi agent credentials import claude-code --source keychain --keychain-service <service> --keychain-account <account>
  $ clawdi agent credentials import gh
  $ clawdi agent credentials import aws --from ~/.aws/credentials --to ~/.aws/credentials --yes

Codex model-provider auth:
  $ clawdi ai-provider import-auth openai-codex --tool codex --yes`,
	)
	.action(async (tool: string, opts) => {
		const { agentCredentialsImportCommand } = await import("./commands/agent-credentials.js");
		await agentCredentialsImportCommand(tool, opts);
	});

agentCredentialsCmd
	.command("materialize <tool>")
	.description("Recreate a personal local CLI credential profile on this machine")
	.option("-p, --project <id-or-slug>", "Read from a specific project")
	.option("--profile <name>", "Profile name", "default")
	.option("--to <path>", "Override destination path (only for single-file profiles)")
	.option("-y, --yes", "Skip confirmation (required in a non-interactive shell)")
	.option("--no-backup", "Overwrite existing files without creating .bak-* copies")
	.option("--dry-run", "Show what would be written without changing files")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi agent credentials materialize claude-code
  $ clawdi agent credentials materialize gh
  $ clawdi agent credentials materialize aws --profile work --to ~/.aws/credentials --yes`,
	)
	.action(async (tool: string, opts) => {
		const { agentCredentialsMaterializeCommand } = await import("./commands/agent-credentials.js");
		await agentCredentialsMaterializeCommand(tool, opts);
	});

const agentProjectsCmd = agentCmd
	.command("projects")
	.description("View workspace and linked projects");

agentProjectsCmd
	.command("list <agent-id>")
	.description("Show workspace and linked-project vault priority")
	.option("--json", "Output as JSON")
	.action(async (agentId, opts) => {
		const { agentProjectsListCommand } = await import("./commands/agent-projects.js");
		await agentProjectsListCommand(agentId, opts);
	});

agentProjectsCmd
	.command("link <agent-id>")
	.alias("attach")
	.description("Link a project for vault resolution")
	.requiredOption("-p, --project <id-or-slug>", "Project UUID, slug, name, or @owner/slug")
	.option("--order <n>", "Vault resolution priority (>=1)", parsePositiveInteger)
	.option("--json", "Output as JSON")
	.action(async (agentId, opts) => {
		const { agentProjectsAddContextCommand } = await import("./commands/agent-projects.js");
		await agentProjectsAddContextCommand(agentId, opts);
	});

agentProjectsCmd
	.command("unlink <agent-id>")
	.alias("detach")
	.description("Unlink a project from vault resolution")
	.requiredOption("-p, --project <id-or-slug>", "Project UUID, slug, name, or @owner/slug")
	.option("-y, --yes", "Skip the interactive confirmation prompt")
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi agent projects unlink <agent-id> --project engineering --yes",
	)
	.option("--json", "Output as JSON")
	.action(async (agentId, opts) => {
		const { agentProjectsRemoveContextCommand } = await import("./commands/agent-projects.js");
		await agentProjectsRemoveContextCommand(agentId, opts);
	});

agentProjectsCmd
	.command("move <agent-id>")
	.description("Update vault resolution priority")
	.option(
		"--item <id:order>",
		"Linked project relation ID and target vault priority (repeatable)",
		collectValues,
		[] as string[],
	)
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi agent projects move <agent-id> --item <id>:1 --item <id>:2",
	)
	.option("--json", "Output as JSON")
	.action(async (agentId, opts) => {
		const { agentProjectsReorderCommand } = await import("./commands/agent-projects.js");
		await agentProjectsReorderCommand(agentId, opts);
	});

// ─────────────────────────────────────────────────────────────
// inbox — incoming invitations and share URLs awaiting my action.
// ─────────────────────────────────────────────────────────────
const inboxCmd = program
	.command("inbox")
	.description("Incoming project invites and share links")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		// `clawdi inbox` (no subcommand) → list pending invitations
		const { inboxListCommand } = await import("./commands/inbox.js");
		await inboxListCommand(opts);
	});

inboxCmd
	.command("accept [id-or-url]")
	.description("Accept an invitation, or stage/join a share link based on auth state")
	.option("--invite <id>", "Explicit invitation UUID (bypass shape detection)")
	.option("--url <link>", "Explicit share URL (bypass shape detection)")
	.option(
		"-a, --agent <agent-id>",
		"Link the accepted project to one or more agents (repeat or comma-separate)",
		collectCsvValues,
		[] as string[],
	)
	.option("--use-as <attached>", "Link to --agent (compatibility value: attached)")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		`
Examples:
  Human-friendly (polymorphic):
    $ clawdi inbox accept https://clawdi.ai/share/abc...
    $ clawdi inbox accept 1a2b3c4d-...    # invitation id

  Accept and link to agent:
    $ clawdi inbox accept --url <link> --agent <agent-id>
    $ clawdi inbox accept --invite <id> --agent <agent-id>`,
	)
	.action(async (idOrUrl, opts) => {
		const { inboxAcceptCommand } = await import("./commands/inbox.js");
		await inboxAcceptCommand(idOrUrl, opts);
	});

inboxCmd
	.command("join <project-id>")
	.description("Explicitly join one locally staged project share")
	.option(
		"-a, --agent <agent-id>",
		"Link the joined project to one or more agents (repeat or comma-separate)",
		collectCsvValues,
		[] as string[],
	)
	.option("--use-as <attached>", "Link to --agent (compatibility value: attached)")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		`
Example:
  $ clawdi auth login
  $ clawdi inbox join <project-id>
  $ clawdi pull --project <project-id>`,
	)
	.action(async (projectId, opts) => {
		const { inboxJoinCommand } = await import("./commands/inbox.js");
		await inboxJoinCommand(projectId, opts);
	});

inboxCmd
	.command("decline <id>")
	.description("Decline a pending invitation")
	.option("-y, --yes", "Skip the interactive confirmation prompt")
	.addHelpText("after", "\nExample:\n  $ clawdi inbox decline <id> --yes")
	.option("--json", "Output as JSON")
	.action(async (id, _opts, cmd) => {
		const { inboxDeclineCommand } = await import("./commands/inbox.js");
		await inboxDeclineCommand(id, cmd.optsWithGlobals());
	});

inboxCmd
	.command("forget <project-id>")
	.description("Local-only: remove a share record and its cached files")
	.option("-y, --yes", "Confirm removing the local share record")
	.option("--json", "Output as JSON")
	.action(async (projectId, _opts, cmd) => {
		const { inboxForgetCommand } = await import("./commands/inbox.js");
		await inboxForgetCommand(projectId, cmd.optsWithGlobals());
	});

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
