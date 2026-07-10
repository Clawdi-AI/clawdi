#!/usr/bin/env node
import { Command, Option } from "commander";
import { registerServeCommand } from "./commands/serve-cli.js";
import { loadAuthTokenFile } from "./lib/auth-token-file.js";
import { handleError } from "./lib/errors.js";
import { getCliVersion } from "./lib/version.js";
import { evaluateHostPolicyForCommand } from "./runtime/host-policy.js";

const program = new Command();

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
	.description("iCloud for AI Agents — share sessions, skills, vault across agents")
	.version(getCliVersion())
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi auth login               Authenticate with Clawdi Cloud
  $ clawdi auth status --json       Inspect credential source without printing secrets
  $ clawdi setup                    Detect agents and register the current machine
  $ clawdi session list             Preview local sessions before pushing
  $ clawdi push --all               Upload everything (every agent, project, module)
  $ clawdi pull --all               Download everything from the cloud
  $ clawdi skill list --json        Machine-readable skill listing
  $ clawdi memory search "redis"    Search memories by text
  $ clawdi vault set OPENAI_API_KEY Store a secret
  $ clawdi project folder link --project engineering  Use this folder with a Project
  $ clawdi run --env-file .env.clawdi -- npm run dev  Resolve clawdi:// refs at runtime
  $ clawdi runtime status --json    Inspect hosted runtime boot state

Environment:
  CLAWDI_API_URL           Override the Clawdi Cloud API endpoint
  CLAWDI_DEBUG             Print stack traces on error
  CLAWDI_NO_UPDATE_CHECK   Suppress the non-blocking update check
  CLAWDI_NO_AUTO_UPDATE    Skip CLI/daemon background auto-update (also disables via \`config set autoUpdate false\`)
  CLAWDI_RUNTIME_MODE      Explicit runtime mode override for hosted tests/operators
  CLAWDI_AUTH_TOKEN        Clawdi Cloud auth token; the only hosted container credential
  CLAWDI_RUNTIME_BRIDGE_TOKEN
                           Hosted runtime bridge token for authenticated surfaces
  CLAUDE_CONFIG_DIR        Custom Claude Code home (else ~/.claude)
  CODEX_HOME               Custom Codex home (else ~/.codex)
  HERMES_HOME              Custom Hermes home (else ~/.hermes)
  OPENCLAW_STATE_DIR       Custom OpenClaw state dir (else auto-detect)
  OPENCLAW_AGENT_ID        OpenClaw agent id (else "main")
  CI / GITHUB_ACTIONS / …  Disable interactive prompts in known CI

Docs: https://github.com/Clawdi-AI/clawdi`,
	);

program.hook("preAction", (_thisCommand, actionCommand) => {
	const command = commandPath(actionCommand);
	const decision = evaluateHostPolicyForCommand(command);
	if (decision.allowed) return;
	const reason = decision.reason ?? "disabled by hosted runtime policy";
	throw new Error(`Command \`clawdi ${command}\` is disabled in hosted runtime mode: ${reason}`);
});

// ─────────────────────────────────────────────────────────────
// auth
// ─────────────────────────────────────────────────────────────
const authCmd = program.command("auth").description("Authenticate with Clawdi Cloud");

authCmd
	.command("login")
	.description("Authorize this machine via the dashboard (browser-based)")
	.option("--manual", "Skip the browser flow and paste an API key instead")
	.addHelpText("after", "\nExamples:\n  $ clawdi auth login\n  $ clawdi auth login --manual")
	.action(async (opts: { manual?: boolean }) => {
		const { authLogin } = await import("./commands/auth.js");
		await authLogin(opts);
	});

authCmd
	.command("complete")
	.description("Finish a login started in non-interactive mode (after browser approval)")
	.action(async () => {
		const { authComplete } = await import("./commands/auth.js");
		await authComplete();
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
// config
// ─────────────────────────────────────────────────────────────
const configCmd = program
	.command("config")
	.description("Read or write CLI configuration (~/.clawdi/config.json)");

configCmd
	.command("list")
	.description("Show all configured values")
	.action(async () => {
		const { configList } = await import("./commands/config.js");
		configList();
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
	.description("Print the stored value for a key (exit 1 if unset)")
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
	.option("--agent <type>", "Agent type (claude_code, codex, openclaw, hermes)")
	.option("-y, --yes", "Register every detected agent without prompting")
	.option("--no-daemon", "Skip installing/starting background sync daemons")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi setup\n  $ clawdi setup --yes\n  $ clawdi setup --agent claude_code\n  $ clawdi setup --no-daemon",
	)
	.action(async (opts) => {
		const { setup } = await import("./commands/setup.js");
		await setup(opts);
	});

program
	.command("teardown")
	.description("Reverse setup: remove env file, bundled skill, and MCP entry")
	.option("--agent <type>", "Tear down a single agent (claude_code, codex, openclaw, hermes)")
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
  $ clawdi teardown --agent hermes --keep-skill`,
	)
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
		"Narrow to specific modules (comma-separated: sessions,skills). Default: all.",
	)
	.option(
		"--project <path>",
		"Push sessions from a specific local project path (default: current directory)",
	)
	.option(
		"--exclude-project <path>",
		"Exclude a project path (repeatable, mutex with --project)",
		(value: string, prev: string[] = []) => prev.concat(value),
		[] as string[],
	)
	.option(
		"--all",
		"Push everything: every module, every registered agent, every project (each axis still narrowable via --modules / --agent / --project)",
	)
	.option("--agent <type>", "Narrow to one agent (claude_code, codex, hermes, openclaw)")
	.option("--all-agents", "Push from every registered agent on this machine (implied by --all)")
	.option("--dry-run", "Preview without uploading")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi push --all                      Push everything (every agent, project, module)
  $ clawdi push                            Push cwd project for the registered agent (or all of them if multiple)
  $ clawdi push --modules skills           Push only skills (cwd project, registered agent(s))
  $ clawdi push --agent claude_code --dry-run
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
		"Pull cloud data — `skills` writes archives to agent dirs; `sessions` mirrors to ~/.clawdi/sessions/",
	)
	.option(
		"--modules <modules>",
		"Narrow to specific modules (comma-separated: skills,sessions). Default: all.",
	)
	.option(
		"-p, --project <id-or-slug>",
		"Pull skills from an explicit project into the target agent(s)",
	)
	.option("--agent <type>", "Narrow to one agent (claude_code, codex, hermes, openclaw)")
	.option(
		"--all",
		"Pull everything: every module, every registered agent (still narrowable via --modules / --agent)",
	)
	.option("--all-agents", "Pull for every registered agent on this machine (implied by --all)")
	.option(
		"--dry-run",
		"Preview without downloading. Use to check which skills will be overwritten locally.",
	)
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi pull --all                    Pull everything (every agent, every module)
  $ clawdi pull                          Pull for the registered agent (or all of them if multiple)
  $ clawdi pull --modules sessions
  $ clawdi pull --agent claude_code --dry-run
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
const aiProviderCmd = program.command("ai-provider").description("Manage AI Providers");

aiProviderCmd
	.command("list")
	.description("List configured AI Providers")
	.option("--json", "Emit machine-readable JSON")
	.action(async (opts) => {
		const { aiProviderListCommand } = await import("./commands/ai-provider.js");
		await aiProviderListCommand(opts);
	});

aiProviderCmd
	.command("add <provider-id>")
	.description("Add an AI Provider to the local Provider Catalog")
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
	.option("--json", "Emit machine-readable JSON")
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
	.description("Edit an AI Provider")
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
	.option("--json", "Emit machine-readable JSON")
	.action(async (providerId: string, opts) => {
		const { aiProviderEditCommand } = await import("./commands/ai-provider.js");
		await aiProviderEditCommand(providerId, opts);
	});

aiProviderCmd
	.command("remove <provider-id>")
	.alias("rm")
	.description("Remove an AI Provider")
	.option("--force", "Remove even if defaults reference it")
	.option("--json", "Emit machine-readable JSON")
	.action(async (providerId: string, opts) => {
		const { aiProviderRemoveCommand } = await import("./commands/ai-provider.js");
		await aiProviderRemoveCommand(providerId, opts);
	});

aiProviderCmd
	.command("validate [provider-id]")
	.description("Validate the AI Provider Catalog")
	.option("--allow-no-auth-public", "Allow no-auth providers on public URLs")
	.option("--json", "Emit machine-readable JSON")
	.action(async (providerId: string | undefined, opts) => {
		const { aiProviderValidateCommand } = await import("./commands/ai-provider.js");
		await aiProviderValidateCommand(providerId, opts);
	});

aiProviderCmd
	.command("test <provider-id>")
	.description("Check provider config and auth availability")
	.option("--model <model>", "Model to validate against when a provider-specific probe supports it")
	.option("--timeout <seconds>", "Provider probe timeout in seconds", "10")
	.option("--live", "Also run a direct provider metadata probe")
	.option("--probe", "Deprecated alias for --live")
	.option("--no-probe", "Compatibility flag; live probes are disabled unless --live is passed")
	.option("--json", "Emit machine-readable JSON")
	.action(async (providerId: string, opts) => {
		const { aiProviderTestCommand } = await import("./commands/ai-provider.js");
		await aiProviderTestCommand(providerId, opts);
	});

aiProviderCmd
	.command("connect <provider-id>")
	.description("Connect provider auth through an OAuth/device-code flow")
	.option("--method <method>", "Connect method", "oauth")
	.option("--tool <tool>", "Tool login profile to connect, currently codex")
	.option("--callback <mode>", "OAuth callback mode: loopback or manual")
	.option("--redirect-uri <uri>", "Override OAuth redirect URI for manual callback mode")
	.option("--timeout <seconds>", "Seconds to wait for loopback callback", "600")
	.option("--no-open", "Do not open the browser automatically")
	.option("--dry-run", "Show the OAuth start request without running it")
	.option("--json", "Emit machine-readable JSON")
	.action(async (providerId: string, opts) => {
		const { aiProviderConnectCommand } = await import("./commands/ai-provider.js");
		await aiProviderConnectCommand(providerId, opts);
	});

aiProviderCmd
	.command("complete-oauth <provider-id>")
	.description("Complete AI Provider OAuth with a pasted redirect URL or code/state")
	.option("--redirect-url <url>", "Full OAuth redirect URL containing code and state")
	.option("--code <code>", "OAuth authorization code")
	.option("--state <state>", "OAuth state returned by connect")
	.option("--redirect-uri <uri>", "Redirect URI used for the OAuth start request")
	.option("--json", "Emit machine-readable JSON")
	.action(async (providerId: string, opts) => {
		const { aiProviderCompleteOAuthCommand } = await import("./commands/ai-provider.js");
		await aiProviderCompleteOAuthCommand(providerId, opts);
	});

aiProviderCmd
	.command("import-auth <provider-id>")
	.description("Import a local auth profile and bind it to an AI Provider")
	.option("--tool <tool>", "Tool profile to import, currently codex")
	.option("--profile <name>", "Profile name", "default")
	.option("--source <source>", "Credential source: file or keychain", "file")
	.option("--from <path>", "Credential file to import")
	.option("--to <path>", "Materialization target path to store with the profile")
	.option("--keychain-service <service>", "macOS Keychain service name for --source keychain")
	.option("--keychain-account <account>", "macOS Keychain account name for --source keychain")
	.option("-y, --yes", "Skip confirmation prompt")
	.option("--dry-run", "Show what would be imported without storing anything")
	.option("--json", "Emit machine-readable JSON")
	.action(async (providerId: string, opts) => {
		const { aiProviderImportAuthCommand } = await import("./commands/ai-provider.js");
		await aiProviderImportAuthCommand(providerId, opts);
	});

aiProviderCmd
	.command("materialize-auth <provider-id>")
	.description("Materialize an AI Provider's local auth profile on this machine")
	.option("--to <path>", "Override destination path (only for single-file profiles)")
	.option("-y, --yes", "Skip confirmation prompt")
	.option("--no-backup", "Overwrite existing files without creating .bak-* copies")
	.option("--dry-run", "Show what would be written without changing files")
	.option("--json", "Emit machine-readable JSON")
	.action(async (providerId: string, opts) => {
		const { aiProviderMaterializeAuthCommand } = await import("./commands/ai-provider.js");
		await aiProviderMaterializeAuthCommand(providerId, opts);
	});

aiProviderCmd
	.command("apply [source]")
	.description("Apply AI Provider config and target-native auth to verified agent entrypoints")
	.option("--source <source>", "AI Provider source: provider id, default, or all")
	.option("--target <target>", "Agent target: all, codex, hermes, or openclaw (default: all)")
	.option("--dry-run", "Preview writes and agent CLI commands without changing files")
	.option("--json", "Emit machine-readable JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi ai-provider apply openai-main --target codex --dry-run
  $ clawdi ai-provider apply openai-codex

Codex OAuth sources are applied as source -> target. Non-dry-run apply writes
the compatible target config and the target's native auth store.`,
	)
	.action(async (source: string | undefined, opts) => {
		const { aiProviderApplyCommand } = await import("./commands/ai-provider-apply.js");
		await aiProviderApplyCommand({ ...opts, source: opts.source ?? source });
	});

aiProviderCmd
	.command("status")
	.description("Inspect AI Provider agent apply state")
	.option("--json", "Emit machine-readable JSON")
	.action(async (opts) => {
		const { aiProviderStatusCommand } = await import("./commands/ai-provider-apply.js");
		await aiProviderStatusCommand(opts);
	});

aiProviderCmd
	.command("export")
	.description("Export Provider Catalog metadata and refs")
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
	.description("Import and merge a Provider Catalog file")
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
	.option("--json", "Emit machine-readable JSON")
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
	.command("list")
	.description("List your private channel bots")
	.option("--json", "Emit machine-readable JSON")
	.action(async (opts: { json?: boolean }) => {
		const { channelListCommand } = await import("./commands/channel.js");
		await channelListCommand(opts);
	});

channelCmd
	.command("available")
	.description("List available channel bots")
	.option("--json", "Emit machine-readable JSON")
	.action(async (opts: { json?: boolean }) => {
		const { channelAvailableCommand } = await import("./commands/channel.js");
		await channelAvailableCommand(opts);
	});

channelCmd
	.command("get <channel-id>")
	.description("Show channel bot details")
	.option("--json", "Emit machine-readable JSON")
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
	.option("--json", "Emit machine-readable JSON")
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
	.option("--json", "Emit machine-readable JSON")
	.action(async (channelId: string, opts: { json?: boolean }) => {
		const { channelLinksCommand } = await import("./commands/channel.js");
		await channelLinksCommand(channelId, opts);
	});

channelCmd
	.command("link <channel-id>")
	.description("Link an accessible bot to one of your agents")
	.requiredOption("--agent <agent-id>", "Target agent id")
	.option("--json", "Emit machine-readable JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi channel link <channel-id> --agent <agent-id>")
	.action(async (channelId: string, opts) => {
		const { channelLinkCommand } = await import("./commands/channel.js");
		await channelLinkCommand(channelId, opts);
	});

channelCmd
	.command("rotate-token <channel-id>")
	.description("Rotate the agent SDK token for one of your bot-agent links")
	.requiredOption("--link <link-id>", "Bot-agent link id")
	.option("--json", "Emit machine-readable JSON")
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
	.option("--ttl <seconds>", "Pair code TTL in seconds", "900")
	.option("--json", "Emit machine-readable JSON")
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
	.option("--json", "Emit machine-readable JSON")
	.addHelpText(
		"after",
		'\nExample:\n  $ clawdi channel send <channel-id> --binding <binding-id> --text "deploy done"',
	)
	.action(async (channelId: string, opts) => {
		const { channelSendCommand } = await import("./commands/channel.js");
		await channelSendCommand(channelId, opts);
	});

channelCmd
	.command("bindings <channel-id>")
	.description("List your paired external chats for a channel")
	.option("--json", "Emit machine-readable JSON")
	.action(async (channelId: string, opts: { json?: boolean }) => {
		const { channelBindingsCommand } = await import("./commands/channel.js");
		await channelBindingsCommand(channelId, opts);
	});

channelCmd
	.command("sync-commands <channel-id>")
	.description("Sync provider slash commands for one of your private bots")
	.option("--guild <guild-id>", "Discord guild id for guild-scoped command sync")
	.option("--commands <json>", "Command spec JSON array; defaults to bot_pair and bot_unpair")
	.option("--json", "Emit machine-readable JSON")
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
	.option("--yes", "Confirm deletion without prompting")
	.option("--json", "Emit machine-readable JSON")
	.addHelpText("after", "\nExample:\n  $ clawdi channel delete <channel-id> --yes")
	.action(async (channelId: string, opts: { yes?: boolean; json?: boolean }) => {
		const { channelDeleteCommand } = await import("./commands/channel.js");
		await channelDeleteCommand(channelId, opts);
	});

// ─────────────────────────────────────────────────────────────
// runtime manifest
// ─────────────────────────────────────────────────────────────
const runtimeCmd = program
	.command("runtime")
	.description("Hosted runtime boot and channel runtime projections");

runtimeCmd
	.command("init")
	.description("Converge a hosted runtime from controller desired state")
	.option("--non-interactive", "Required for hosted boot; never prompt")
	.option("--json", "Output as JSON")
	.option("--manifest-file <path>", "Use a local runtime manifest fixture for simulation")
	.action(async (opts: { nonInteractive?: boolean; json?: boolean; manifestFile?: string }) => {
		const { runtimeInit } = await import("./commands/runtime.js");
		await runtimeInit(opts);
	});

runtimeCmd
	.command("watch")
	.description("Watch hosted runtime desired state and apply live changes")
	.option("--interval-ms <ms>", "Polling interval in milliseconds")
	.option("--self-heal-ms <ms>", "Maximum interval before forcing a full manifest fetch")
	.option("--once", "Run one watch iteration and exit")
	.option("--json", "Emit machine-readable JSON events")
	.action(
		async (opts: { intervalMs?: string; selfHealMs?: string; once?: boolean; json?: boolean }) => {
			const { runtimeWatch } = await import("./commands/runtime.js");
			await runtimeWatch(opts);
		},
	);

runtimeCmd
	.command("verify")
	.description("Validate hosted runtime CLI modules and cached manifest")
	.option("--json", "Emit machine-readable JSON")
	.action(async (opts: { json?: boolean }) => {
		const { runtimeVerify } = await import("./commands/runtime.js");
		await runtimeVerify(opts);
	});

runtimeCmd
	.command("sidecar")
	.description("Run hosted runtime support modules")
	.action(async () => {
		const { runtimeSidecar } = await import("./commands/runtime.js");
		await runtimeSidecar();
	});

runtimeCmd
	.command("plan")
	.description("Preview channel account, link, and runtime projection changes")
	.option("-f, --file <path>", "Runtime manifest path", "clawdi.runtime.yaml")
	.option("--json", "Emit machine-readable JSON")
	.action(async (opts: { file?: string; json?: boolean }) => {
		const { runtimePlanCommand } = await import("./commands/runtime.js");
		await runtimePlanCommand(opts);
	});

runtimeCmd
	.command("apply")
	.description("Create or reuse channel runtime resources from a manifest")
	.option("-f, --file <path>", "Runtime manifest path", "clawdi.runtime.yaml")
	.option("--dry-run", "Preview changes without mutating backend or local files")
	.option(
		"--rotate-missing-tokens",
		"Rotate existing link tokens only when local output lacks them",
	)
	.option("--rotate-all-tokens", "Rotate every declared link token")
	.option("--yes", "Reserved for future destructive confirmations")
	.option("--json", "Emit machine-readable JSON")
	.action(
		async (opts: {
			file?: string;
			dryRun?: boolean;
			rotateMissingTokens?: boolean;
			rotateAllTokens?: boolean;
			yes?: boolean;
			json?: boolean;
		}) => {
			const { runtimeApplyCommand } = await import("./commands/runtime.js");
			await runtimeApplyCommand(opts);
		},
	);

runtimeCmd
	.command("status")
	.description("Show hosted runtime boot status, or channel manifest status with --file")
	.option("-f, --file <path>", "Channel runtime manifest path")
	.option("--json", "Emit machine-readable JSON")
	.action(async (opts: { file?: string; json?: boolean }) => {
		const { runtimeStatus, runtimeStatusCommand } = await import("./commands/runtime.js");
		if (opts.file) {
			await runtimeStatusCommand(opts);
			return;
		}
		await runtimeStatus(opts);
	});

runtimeCmd
	.command("doctor")
	.description("Diagnose hosted runtime policy, paths, and last boot state")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { runtimeDoctor } = await import("./commands/runtime.js");
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
  Vaults are account-level key bundles. Projects attach to a Vault to use the
  same shared key set. set/import update the Vault for every attached Project.
  rm deletes a key from the Vault; detach only removes one Project's access.
  Key paths are KEY, vault/KEY, or vault/section/KEY.`,
	);

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
	.option("-y, --yes", "Skip the confirmation prompt (for CI / scripted imports)")
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
	.description("Make an existing Vault available in a Project")
	.requiredOption("-p, --project <id-or-slug>", "Project that should use this Vault")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault attach providers --project redpill-providers",
	)
	.action(async (vault, opts) => {
		const { vaultAttach } = await import("./commands/vault.js");
		await vaultAttach(vault, { project: opts.project });
	});

vaultCmd
	.command("detach <vault>")
	.alias("unlink")
	.description("Remove a Project's access to a Vault without deleting keys")
	.requiredOption("-p, --project <id-or-slug>", "Project that should stop using this Vault")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault detach providers --project env-abc123\n  $ clawdi vault unlink providers --project old-agent",
	)
	.action(async (vault, opts) => {
		const { vaultDetach } = await import("./commands/vault.js");
		await vaultDetach(vault, { project: opts.project });
	});

vaultCmd
	.command("rm <key>")
	.alias("delete")
	.description("Delete a key from a Vault")
	.option(
		"-p, --project <id-or-slug>",
		"Select the Project used to locate the Vault (default: your default-write project)",
	)
	.option("-y, --yes", "Skip the confirmation prompt")
	.option(
		"--global",
		"Allow deleting a key from a Vault attached to multiple Projects (affects every Project using it)",
	)
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault rm OPENAI_API_KEY\n  $ clawdi vault delete prod/stripe/SECRET_KEY --project engineering --yes\n  $ clawdi vault rm OPENAI_API_KEY --project engineering --global --yes",
	)
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
	.option("-a, --agent <agent-id-or-type>", "Resolve through Agent Project and attachments")
	.option("--allow-conflicts", "Allow first-match wins for agent project conflicts")
	.option("--debug", "Show project precedence and skipped matches")
	.option("--dry-run", "Check where the key resolves without printing the plaintext value")
	.option("--json", "Output the full resolve response as JSON")
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
	.option("-a, --agent <agent-id-or-type>", "Resolve through Agent Project and attachments")
	.option("--allow-conflicts", "Allow first-match wins for agent project conflicts")
	.option("--debug", "Show project precedence without printing secrets in diagnostics")
	.option("--dry-run", "Check the reference without printing the plaintext value")
	.option("--json", "Output the full resolve response as JSON")
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
	.option("-a, --agent <agent-id-or-type>", "Resolve through Agent Project and attachments")
	.option("--allow-conflicts", "Allow first-match wins for agent project conflicts")
	.option("--no-project-folder", "Skip linked-folder Project lookup")
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
	.option("-a, --agent <type>", "Upload to an Agent Project (claude_code, codex, hermes, openclaw)")
	.option(
		"-p, --project <id-or-slug>",
		"Upload to an explicit project (UUID, slug, or name). Mutex with --agent.",
	)
	.option("-y, --yes", "Skip the confirmation prompt")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi skill add ./my-skill                         # default project\n  $ clawdi skill add ./my-skill --project engineering   # explicit project\n  $ clawdi skill add ./my-skill --agent codex            # Agent Project",
	)
	.action(async (path, opts) => {
		const { skillAdd } = await import("./commands/skill.js");
		await skillAdd(path, { ...opts, project: opts.project });
	});

skillCmd
	.command("install <repo>")
	.description("Install a skill from GitHub (owner/repo or owner/repo/path)")
	.option("-a, --agent <type>", "Install to a single agent (claude_code, codex, hermes, openclaw)")
	.option(
		"-p, --project <id-or-slug>",
		"Install into an explicit owned project (UUID, slug, or name). Mutex with --agent.",
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
	.action(async (repo, opts) => {
		const { skillInstall } = await import("./commands/skill.js");
		await skillInstall(repo, opts);
	});

skillCmd
	.command("rm <key>")
	.description("Remove a skill from the cloud")
	.option(
		"-a, --agent <type>",
		"Remove from an Agent Project (claude_code, codex, hermes, openclaw)",
	)
	.option(
		"-p, --project <id-or-slug>",
		"Remove from an explicit owned project (UUID, slug, or name). Mutex with --agent.",
	)
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
const sessionCmd = program.command("session").description("Inspect local agent sessions");

sessionCmd
	.command("list")
	.description("List local agent sessions (use before `clawdi push` to preview)")
	.option("--agent <type>", "Single agent (claude_code, codex, hermes, openclaw)")
	.option("--all-agents", "List sessions from every registered agent (default)")
	.option("--project <path>", "Restrict to one project path")
	.option("--all", "List sessions from all projects (default when --project not set)")
	.option("--since <date>", "Only list sessions started after this date")
	.option("--limit <n>", "Cap results", "100")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi session list
  $ clawdi session list --json
  $ clawdi session list --agent claude_code --project ~/work/foo`,
	)
	.action(async (opts) => {
		const { sessionList } = await import("./commands/session.js");
		await sessionList(opts);
	});

sessionCmd
	.command("extract <session-id>")
	.description("Extract memories from a session via the cloud's configured LLM")
	.option("--json", "Output result as JSON")
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
	.option("--limit <n>", "Max number of memories")
	.option("--category <cat>", "Filter by category (fact/preference/pattern/decision/context)")
	.action(async (opts) => {
		const { memoryList } = await import("./commands/memory.js");
		await memoryList(opts);
	});

memoryCmd
	.command("search <query>")
	.description("Search memories by text")
	.option("--json", "Output as JSON")
	.option("--limit <n>", "Max number of memories")
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
	.action(async (content, opts) => {
		const { memoryAdd } = await import("./commands/memory.js");
		await memoryAdd(content, opts);
	});

memoryCmd
	.command("rm <id>")
	.description("Delete a memory")
	.action(async (id) => {
		const { memoryRm } = await import("./commands/memory.js");
		await memoryRm(id);
	});

// ─────────────────────────────────────────────────────────────
// doctor / update
// ─────────────────────────────────────────────────────────────
program
	.command("doctor")
	.description("Diagnose auth, agents, vault, and MCP connectivity")
	.argument("[topic]", "Optional doctor topic, e.g. ai-provider")
	.option("--json", "Output as JSON")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi doctor\n  $ clawdi doctor --json\n  $ clawdi doctor ai-provider",
	)
	.action(async (topic: string | undefined, opts) => {
		if (topic === "ai-provider") {
			const { doctorAiProviderCommand } = await import("./commands/ai-provider-apply.js");
			await doctorAiProviderCommand(opts);
			return;
		}
		if (topic) {
			throw new Error(`Unknown doctor topic: ${topic}`);
		}
		const { doctor } = await import("./commands/doctor.js");
		await doctor(opts);
	});

program
	.command("capabilities")
	.description("Show CLI feature surface and hosted policy restrictions")
	.option("--json", "Output as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { capabilitiesCommand } = await import("./commands/capabilities.js");
		await capabilitiesCommand(opts);
	});

program
	.command("update")
	.description("Install the latest CLI from npm (--check to only diagnose)")
	.option("--check", "Only check for updates, don't install")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const { update } = await import("./commands/update.js");
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
	.option("-p, --project <id-or-slug>", "Resolve references from an explicit Project")
	.option("-a, --agent <agent-id-or-type>", "Resolve through Agent Project and attachments")
	.option(
		"--env-file <file>",
		"Load dotenv-like file and resolve clawdi:// references",
		(value, previous: string[]) => [...previous, value],
		[],
	)
	.option("--no-inherit-env", "Do not inherit the parent process environment")
	.option("--all-vault-env", "Legacy mode: inject every vault env value from the selected Project")
	.option("--allow-conflicts", "Allow first-match wins for agent project conflicts")
	.option("--no-project-folder", "Skip linked-folder Project lookup")
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
  project list hides auto-created machine/environment projects by default.
  Use project list --include-envs to inspect those scopes.`,
	);

projectCmd
	.command("create <name>")
	.description("Create a project")
	.option("--slug <slug>", "Optional stable slug (lowercase letters, numbers, hyphens)")
	.option("--json", "Emit machine-readable JSON (agent contract)")
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
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.option("--shared-with-me", "Show only projects shared with you")
	.option("--owned", "Show only projects you own")
	.option("--include-envs", "Include auto-created machine/environment projects")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi project list\n  $ clawdi project list --include-envs\n  $ clawdi project list --shared-with-me --json",
	)
	.action(
		async (opts: {
			json?: boolean;
			sharedWithMe?: boolean;
			owned?: boolean;
			includeEnvs?: boolean;
		}) => {
			const { projectListCommand } = await import("./commands/project-list.js");
			await projectListCommand(opts);
		},
	);

projectCmd
	.command("show <project>")
	.description("Show project content, role, owner, and next actions")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.action(async (project: string, opts: { json?: boolean }) => {
		const { projectShowCommand } = await import("./commands/project-show.js");
		await projectShowCommand(project, opts);
	});

const projectFolderCmd = projectCmd
	.command("folder")
	.description("Link local folders to Projects for automatic vault env selection");

projectFolderCmd
	.command("link [path]")
	.description("Use this folder with a Project")
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
	.description("Stop using this folder with its linked Project")
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
	.description("Show which Project clawdi run will use for a folder")
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
	.action(async (project: string | undefined, opts: { label?: string }) => {
		const { projectShareCommand } = await import("./commands/project-share.js");
		await projectShareCommand(project, opts);
	});

projectCmd
	.command("share-links <project>")
	.description("List or revoke viewer project links")
	.option("--revoke <id-or-prefix>", "Revoke a specific link")
	.action(async (project: string, opts: { revoke?: string }) => {
		const { projectShareLinksCommand } = await import("./commands/project-share-links.js");
		await projectShareLinksCommand(project, opts);
	});

projectCmd
	.command("invite <project>")
	.description("Invite a person to viewer project access")
	.requiredOption("-e, --email <addr>", "Email address to invite")
	.action(async (project: string, opts: { email: string }) => {
		const { projectInviteCommand } = await import("./commands/project-invite.js");
		await projectInviteCommand(project, opts);
	});

projectCmd
	.command("invites <project>")
	.description("List or cancel pending project invites")
	.option("--cancel <id>", "Cancel one of the pending invitations on this project")
	.addHelpText(
		"after",
		"\n  Recipient side (listing / accepting / declining invitations addressed to you)\n" +
			"  lives under `clawdi inbox`.",
	)
	.action(async (project: string, opts: { cancel?: string }) => {
		const { projectInvitesCommand } = await import("./commands/project-invites.js");
		await projectInvitesCommand(project, opts);
	});

projectCmd
	.command("members <project>")
	.description("List or remove people with project access")
	.option("--remove <email-or-user-id>", "Remove one accepted member")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi project members engineering --remove bob@example.com",
	)
	.action(async (project: string, opts: { remove?: string; json?: boolean }) => {
		const { projectMembersCommand } = await import("./commands/project-members.js");
		await projectMembersCommand(project, opts);
	});

projectCmd
	.command("leave <project>")
	.description("Leave a project shared with you")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText("after", "\nExample:\n  $ clawdi project leave @alice-cdbf/engineering")
	.action(async (project: string, opts: { json?: boolean }) => {
		const { projectLeaveCommand } = await import("./commands/project-members.js");
		await projectLeaveCommand(project, opts);
	});

projectCmd
	.command("unshare <project>")
	.description("Owner: revoke links, cancel invites, and remove accepted viewers")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText("after", "\nExample:\n  $ clawdi project unshare engineering")
	.action(async (project: string, opts: { json?: boolean }) => {
		const { projectUnshareCommand } = await import("./commands/project-members.js");
		await projectUnshareCommand(project, opts);
	});

const agentCmd = program.command("agent").description("Manage agents");
const agentCredentialsCmd = agentCmd
	.command("credentials")
	.description("Sync local CLI credential profiles");

agentCredentialsCmd
	.command("import <tool>")
	.description("Import a personal local CLI credential profile into Clawdi Vault")
	.option("-p, --project <id-or-slug>", "Target a specific project")
	.option("--profile <name>", "Profile name", "default")
	.option("--source <source>", "Credential source: file or keychain", "file")
	.option("--from <path>", "Credential file to import (required for tools without an adapter)")
	.option("--to <path>", "Materialization target path to store with the profile")
	.option("--keychain-service <service>", "macOS Keychain service name for --source keychain")
	.option("--keychain-account <account>", "macOS Keychain account name for --source keychain")
	.option("-y, --yes", "Skip confirmation prompt")
	.option("--dry-run", "Show what would be imported without storing anything")
	.option("--json", "Emit machine-readable JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi agent credentials import claude-code
  $ clawdi agent credentials import claude-code --source keychain --keychain-service <service> --keychain-account <account>
  $ clawdi agent credentials import gh
  $ clawdi agent credentials import aws --from ~/.aws/credentials --to ~/.aws/credentials

Codex model-provider auth:
  $ clawdi ai-provider import-auth openai-codex --tool codex`,
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
	.option("-y, --yes", "Skip confirmation prompt")
	.option("--no-backup", "Overwrite existing files without creating .bak-* copies")
	.option("--dry-run", "Show what would be written without changing files")
	.option("--json", "Emit machine-readable JSON")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi agent credentials materialize claude-code
  $ clawdi agent credentials materialize gh
  $ clawdi agent credentials materialize aws --profile work --to ~/.aws/credentials

Codex model-provider auth:
  $ clawdi ai-provider materialize-auth openai-codex`,
	)
	.action(async (tool: string, opts) => {
		const { agentCredentialsMaterializeCommand } = await import("./commands/agent-credentials.js");
		await agentCredentialsMaterializeCommand(tool, opts);
	});

const agentProjectsCmd = agentCmd
	.command("projects")
	.description("View Agent Project and attachments");

agentProjectsCmd
	.command("list <agent-id>")
	.description("Show Agent Project and attachment order")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.action(async (agentId, opts) => {
		const { agentProjectsListCommand } = await import("./commands/agent-projects.js");
		await agentProjectsListCommand(agentId, opts);
	});

agentProjectsCmd
	.command("attach <agent-id>")
	.description("Attach a Project for reads")
	.requiredOption("-p, --project <id-or-slug>", "Project UUID, slug, name, or @owner/slug")
	.option("--order <n>", "Read order (>=1)")
	.action(async (agentId, opts) => {
		const { agentProjectsAddContextCommand } = await import("./commands/agent-projects.js");
		await agentProjectsAddContextCommand(agentId, opts);
	});

agentProjectsCmd
	.command("detach <agent-id>")
	.description("Detach a Project")
	.requiredOption("-p, --project <id-or-slug>", "Project UUID, slug, name, or @owner/slug")
	.action(async (agentId, opts) => {
		const { agentProjectsRemoveContextCommand } = await import("./commands/agent-projects.js");
		await agentProjectsRemoveContextCommand(agentId, opts);
	});

agentProjectsCmd
	.command("move <agent-id>")
	.description("Update attachment order")
	.option(
		"--item <id:order>",
		"Attachment id and target order (repeatable)",
		collectValues,
		[] as string[],
	)
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi agent projects move <agent-id> --item <id>:1 --item <id>:2",
	)
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
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.action(async (opts) => {
		// `clawdi inbox` (no subcommand) → list pending invitations
		const { inboxListCommand } = await import("./commands/inbox.js");
		await inboxListCommand(opts);
	});

inboxCmd
	.command("accept [id-or-url]")
	.description("Accept viewer project access from an invite or share link")
	.option("--invite <id>", "Explicit invitation UUID (bypass shape detection)")
	.option("--url <link>", "Explicit share URL (bypass shape detection)")
	.option(
		"-a, --agent <agent-id>",
		"Attach the accepted project to one or more agents (repeat or comma-separate)",
		collectCsvValues,
		[] as string[],
	)
	.option("--use-as <attached>", "Attach to --agent (default: attached)")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText(
		"after",
		`
Examples:
  Human-friendly (polymorphic):
    $ clawdi inbox accept https://clawdi.ai/share/abc...
    $ clawdi inbox accept 1a2b3c4d-...    # invitation id

  Accept and attach to Agent:
    $ clawdi inbox accept --url <link> --agent <agent-id>
    $ clawdi inbox accept --invite <id> --agent <agent-id>`,
	)
	.action(async (idOrUrl, opts) => {
		const { inboxAcceptCommand } = await import("./commands/inbox.js");
		await inboxAcceptCommand(idOrUrl, opts);
	});

inboxCmd
	.command("decline <id>")
	.description("Decline a pending invitation")
	.action(async (id) => {
		const { inboxDeclineCommand } = await import("./commands/inbox.js");
		await inboxDeclineCommand(id);
	});

inboxCmd
	.command("forget <project-id-or-alias>")
	.description("Local-only: drop a redeemed share-token entry + cached files")
	.action(async (projectId) => {
		const { inboxForgetCommand } = await import("./commands/inbox.js");
		inboxForgetCommand(projectId);
	});

// Auto-update tick: prints any "✓ Updated to v…" notice from a previous
// run's background install, and (when due) kicks off another detached
// install. Best-effort and fully off-the-hot-path — see commands/update.ts.
(async () => {
	try {
		const { maybeAutoUpdate } = await import("./commands/update.js");
		await maybeAutoUpdate();
	} catch {
		// auto-update is opportunistic; never let it kill the CLI invocation
	}
	await program.parseAsync().catch(handleError);
})();
