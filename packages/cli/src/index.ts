#!/usr/bin/env node
import { Command } from "commander";
import { registerServeCommand } from "./commands/serve-cli.js";
import { handleError } from "./lib/errors.js";
import { getCliVersion } from "./lib/version.js";

const program = new Command();

program
	.name("clawdi")
	.description("iCloud for AI Agents — share sessions, skills, vault across agents")
	.version(getCliVersion())
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi auth login               Authenticate with Clawdi Cloud
  $ clawdi setup                    Detect agents and register the current machine
  $ clawdi session list             Preview local sessions before pushing
  $ clawdi push --modules sessions --all-agents --all  Upload everything
  $ clawdi pull                     Download cloud skills to registered agents
  $ clawdi skill list --json        Machine-readable skill listing
  $ clawdi memory search "redis"    Search memories by text
  $ clawdi vault set OPENAI_API_KEY Store a secret
  $ clawdi run -- npm run deploy    Run a command with vault secrets injected

Environment:
  CLAWDI_API_URL           Override the Clawdi Cloud API endpoint
  CLAWDI_DEBUG             Print stack traces on error
  CLAWDI_NO_UPDATE_CHECK   Suppress the non-blocking update check
  CLAWDI_NO_AUTO_UPDATE    Skip background auto-update (also disables via \`config set autoUpdate false\`)
  CLAUDE_CONFIG_DIR        Custom Claude Code home (else ~/.claude)
  CODEX_HOME               Custom Codex home (else ~/.codex)
  HERMES_HOME              Custom Hermes home (else ~/.hermes)
  OPENCLAW_STATE_DIR       Custom OpenClaw state dir (else auto-detect)
  OPENCLAW_AGENT_ID        OpenClaw agent id (else "main")
  CI / GITHUB_ACTIONS / …  Disable interactive prompts in known CI

Docs: https://github.com/Clawdi-AI/clawdi`,
	);

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
	.description("Detect installed agents and register this machine")
	.option("--agent <type>", "Agent type (claude_code, codex, openclaw, hermes)")
	.option("-y, --yes", "Register every detected agent without prompting")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi setup\n  $ clawdi setup --yes\n  $ clawdi setup --agent claude_code",
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
	.option("--modules <modules>", "Comma-separated: sessions,skills")
	.option("--project <path>", "Push a specific project's data (default: current directory)")
	.option(
		"--exclude-project <path>",
		"Exclude a project path (repeatable, mutex with --project)",
		(value: string, prev: string[] = []) => prev.concat(value),
		[] as string[],
	)
	.option("--all", "Push data from all projects")
	.option("--agent <type>", "Target agent (claude_code, codex, hermes, openclaw)")
	.option("--all-agents", "Push from every registered agent on this machine")
	.option("--dry-run", "Preview without uploading")
	.option("-y, --yes", "Skip the upload confirmation prompt")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi push
  $ clawdi push --modules skills
  $ clawdi push --agent claude_code --dry-run
  $ clawdi push --modules sessions --all-agents --all --yes
  $ clawdi push --modules sessions --all-agents --all --exclude-project ~/scratch --yes`,
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
	.option("--modules <modules>", "Comma-separated: skills,sessions")
	.option("--agent <type>", "Target agent (claude_code, codex, hermes, openclaw)")
	.option("--all-agents", "Pull for every registered agent on this machine")
	.option("--dry-run", "Preview without downloading")
	.option("-y, --yes", "Skip confirmation prompts")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi pull
  $ clawdi pull --modules sessions --all-agents --yes
  $ clawdi pull --agent claude_code --dry-run`,
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
// vault
// ─────────────────────────────────────────────────────────────
const vaultCmd = program.command("vault").description("Manage secrets");

vaultCmd
	.command("set <key>")
	.description("Store a secret (prompted for value)")
	.option("-s, --scope <id-or-slug>", "Target a specific scope (default: your default-write scope)")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault set OPENAI_API_KEY\n  $ clawdi vault set DEPLOY_KEY --scope engineering",
	)
	.action(async (key, opts) => {
		const { vaultSet } = await import("./commands/vault.js");
		await vaultSet(key, opts);
	});

vaultCmd
	.command("list")
	.description("List stored keys")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const { vaultList } = await import("./commands/vault.js");
		await vaultList(opts);
	});

vaultCmd
	.command("import <file>")
	.description("Import from .env file")
	.option("-y, --yes", "Skip the confirmation prompt (for CI / scripted imports)")
	.option("-s, --scope <id-or-slug>", "Target a specific scope (default: your default-write scope)")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault import .env.production\n  $ clawdi vault import .env.staging --scope engineering --yes",
	)
	.action(async (file, opts) => {
		const { vaultImport } = await import("./commands/vault.js");
		await vaultImport(file, opts);
	});

vaultCmd
	.command("resolve <key>")
	.description("Resolve one vault key through a composed scope")
	.option("-s, --scope <scope>", "Parent scope to resolve from (default: your default-write scope)")
	.option("--debug", "Show scope precedence and skipped matches")
	.option("--json", "Output the full resolve response as JSON")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault resolve OPENAI_API_KEY\n  $ clawdi vault resolve OPENAI_API_KEY --scope personal --debug",
	)
	.action(async (key, opts) => {
		const { vaultResolveCommand } = await import("./commands/vault-resolve.js");
		await vaultResolveCommand(key, opts);
	});

// ─────────────────────────────────────────────────────────────
// skill
// ─────────────────────────────────────────────────────────────
const skillCmd = program.command("skill").description("Manage skills");

skillCmd
	.command("list")
	.description("List uploaded skills")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		const { skillList } = await import("./commands/skill.js");
		await skillList(opts);
	});

skillCmd
	.command("add <path>")
	.description("Upload a skill directory or single .md file")
	.option(
		"-a, --agent <type>",
		"Upload to a specific agent's scope (claude_code, codex, hermes, openclaw)",
	)
	.option(
		"-s, --scope <id-or-slug>",
		"Upload to an explicit scope (UUID, slug, or name). Mutex with --agent.",
	)
	.option("-y, --yes", "Skip the confirmation prompt")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi skill add ./my-skill                       # default-write scope\n  $ clawdi skill add ./my-skill --scope engineering    # explicit scope\n  $ clawdi skill add ./my-skill --agent codex          # an agent's env-scope",
	)
	.action(async (path, opts) => {
		const { skillAdd } = await import("./commands/skill.js");
		await skillAdd(path, opts);
	});

skillCmd
	.command("install <repo>")
	.description("Install a skill from GitHub (owner/repo or owner/repo/path)")
	.option("-a, --agent <type>", "Install to a single agent (claude_code, codex, hermes, openclaw)")
	.option("-l, --list", "List skills in the repo without installing (planned)")
	.option("-y, --yes", "Skip confirmation prompts")
	.addHelpText(
		"after",
		`
Examples:
  $ clawdi skill install vercel-labs/agent-skills
  $ clawdi skill install owner/repo/path/to/skill
  $ clawdi skill install owner/repo --agent claude_code`,
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
		"Remove from a specific agent's scope (claude_code, codex, hermes, openclaw)",
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
	.option("--json", "Output as JSON")
	.addHelpText("after", "\nExamples:\n  $ clawdi doctor\n  $ clawdi doctor --json")
	.action(async (opts) => {
		const { doctor } = await import("./commands/doctor.js");
		await doctor(opts);
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
	.action(async () => {
		const { startMcpServer } = await import("./mcp/server.js");
		await startMcpServer();
	});

program
	.command("run")
	.description("Run a command with vault secrets injected")
	.argument("<command...>", "Command to run")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi run -- npm run deploy\n  $ clawdi run -- python main.py",
	)
	.action(async (args) => {
		const { run } = await import("./commands/run.js");
		await run(args);
	});

const scopeCmd = program
	.command("scope")
	.description("Manage your scopes — list, share, invite, mount");

scopeCmd
	.command("list")
	.description("List owned scopes + nested mount tree")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.action(async (opts) => {
		const { scopeListCommand } = await import("./commands/scope-list.js");
		await scopeListCommand(opts);
	});

scopeCmd
	.command("show <scope>")
	.description("Show scope metadata, parent-owned content counts, and mount tree")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.action(async (scope, opts) => {
		const { scopeShowCommand } = await import("./commands/scope-show.js");
		await scopeShowCommand(scope, opts);
	});

scopeCmd
	.command("share [scope]")
	.description("Generate a share link. Defaults to your write scope when [scope] is omitted.")
	.option("-l, --label <text>", "Optional label shown in the share-links list")
	.action(async (scope, opts) => {
		const { scopeShareCommand } = await import("./commands/scope-share.js");
		await scopeShareCommand(scope, opts);
	});

scopeCmd
	.command("share-links <scope>")
	.description("List or revoke share links on a scope")
	.option("--revoke <id-or-prefix>", "Revoke a specific link")
	.action(async (scope, opts) => {
		const { scopeShareLinksCommand } = await import("./commands/scope-share-links.js");
		await scopeShareLinksCommand(scope, opts);
	});

scopeCmd
	.command("invite <scope>")
	.description("Send an email invitation to a registered clawdi user")
	.requiredOption("-e, --email <addr>", "Email address to invite")
	.action(async (scope, opts) => {
		const { scopeInviteCommand } = await import("./commands/scope-invite.js");
		await scopeInviteCommand(scope, opts);
	});

scopeCmd
	.command("invites <scope>")
	.description("List pending invitations on a scope you own.")
	.option("--cancel <id>", "Cancel one of the pending invitations on this scope")
	.addHelpText(
		"after",
		"\n  Sharee side (listing / accepting / declining invitations addressed to you)\n" +
			"  lives under `clawdi inbox`.",
	)
	.action(async (scope, opts) => {
		const { scopeInvitesCommand } = await import("./commands/scope-invites.js");
		await scopeInvitesCommand(scope, opts);
	});

scopeCmd
	.command("members <scope>")
	.description("List or remove accepted members on a scope you own")
	.option("--remove <email-or-user-id>", "Remove one accepted member")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText("after", "\nExample:\n  $ clawdi scope members engineering --remove bob@example.com")
	.action(async (scope, opts) => {
		const { scopeMembersCommand } = await import("./commands/scope-members.js");
		await scopeMembersCommand(scope, opts);
	});

scopeCmd
	.command("leave <scope>")
	.description("Leave a shared scope and remove its mount edges from your workspaces")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText("after", "\nExample:\n  $ clawdi scope leave @alice-cdbf/engineering")
	.action(async (scope, opts) => {
		const { scopeLeaveCommand } = await import("./commands/scope-members.js");
		await scopeLeaveCommand(scope, opts);
	});

scopeCmd
	.command("unshare <scope>")
	.description("Owner: revoke links, cancel invitations, and remove all members")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText("after", "\nExample:\n  $ clawdi scope unshare engineering")
	.action(async (scope, opts) => {
		const { scopeUnshareCommand } = await import("./commands/scope-members.js");
		await scopeUnshareCommand(scope, opts);
	});

scopeCmd
	.command("mounts <parent>")
	.description("List scopes mounted into <parent>")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText("after", "\nExample:\n  $ clawdi scope mounts personal")
	.action(async (parent, opts) => {
		const { scopeMountsCommand } = await import("./commands/scope-mount.js");
		await scopeMountsCommand(parent, opts);
	});

scopeCmd
	.command("mount <source>")
	.description("Mount a scope you have access to into a scope you own")
	.requiredOption("-i, --into <parent>", "Parent scope (UUID, slug, or name)")
	.option("-a, --alias <name>", "Override the mount alias (default: @<owner>/<source-slug>)")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.option(
		"--allow-vault-conflicts",
		"Override 409 vault_conflicts_blocked — parent-scope values keep priority",
	)
	.addHelpText(
		"after",
		"\nExample:\n" +
			"  $ clawdi scope mount engineering --into personal\n\n" +
			"For share URLs use `clawdi inbox accept <url>` instead — that joins AND\n" +
			"mounts in one step.",
	)
	.action(async (source, opts) => {
		const { scopeMountCommand } = await import("./commands/scope-mount.js");
		await scopeMountCommand(source, opts);
	});

scopeCmd
	.command("unmount <parent> <alias-or-id>")
	.description("Drop a mount edge. Membership in the source scope is preserved.")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText("after", "\nExample:\n  $ clawdi scope unmount personal @alice-cdbf/engineering")
	.action(async (parent, aliasOrId, opts) => {
		const { scopeUnmountCommand } = await import("./commands/scope-mount.js");
		await scopeUnmountCommand(parent, aliasOrId, opts);
	});

// ─────────────────────────────────────────────────────────────
// inbox — incoming shares awaiting my action.
// Replaces the v1 `share accept|list|remove` verbs:
//   share accept <url>     →  inbox accept <url>
//   share list             →  scope list ("Shared with you but not mounted")
//   share remove <id>      →  inbox forget <id-or-alias>
// ─────────────────────────────────────────────────────────────
const inboxCmd = program
	.command("inbox")
	.description("Incoming invitations + URLs awaiting your action")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.action(async (opts) => {
		// `clawdi inbox` (no subcommand) → list pending invitations
		const { inboxListCommand } = await import("./commands/inbox.js");
		await inboxListCommand(opts);
	});

inboxCmd
	.command("accept [id-or-url]")
	.description("Accept an invitation OR redeem a share URL")
	.option("--invite <id>", "Explicit invitation UUID (bypass shape detection)")
	.option("--url <link>", "Explicit share URL (bypass shape detection)")
	.option("-i, --into <scope>", "Mount target (UUID, slug, or name). Default: auto.")
	.option("-a, --alias <name>", "Override the mount alias")
	.option("--no-mount", "Capability only — skip the mount edge")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.option(
		"--allow-vault-conflicts",
		"Override 409 vault_conflicts_blocked — parent-scope values keep priority",
	)
	.addHelpText(
		"after",
		`
Examples:
  Human-friendly (polymorphic):
    $ clawdi inbox accept https://clawdi.ai/share/abc...
    $ clawdi inbox accept 1a2b3c4d-...    # invitation id

  Agent-blessed (explicit):
    $ clawdi inbox accept --url <link> --into engineering
    $ clawdi inbox accept --invite <id> --into engineering`,
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
	.command("forget <scope-id-or-alias>")
	.description("Local-only: drop a redeemed share-token entry + cached files")
	.action(async (scopeId) => {
		const { inboxForgetCommand } = await import("./commands/inbox.js");
		inboxForgetCommand(scopeId);
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
