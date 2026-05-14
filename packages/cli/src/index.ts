#!/usr/bin/env node
import { Command } from "commander";
import { registerServeCommand } from "./commands/serve-cli.js";
import { handleError } from "./lib/errors.js";
import { getCliVersion } from "./lib/version.js";

const program = new Command();

function collectCsvValues(value: string, prev: string[] = []): string[] {
	const values = value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	return prev.concat(values);
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
	.option(
		"-p, --project <id-or-slug>",
		"Target a specific project (default: your default-write project)",
	)
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault set OPENAI_API_KEY\n  $ clawdi vault set DEPLOY_KEY --project engineering",
	)
	.action(async (key, opts) => {
		const { vaultSet } = await import("./commands/vault.js");
		await vaultSet(key, { ...opts, project: opts.project });
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
	.option(
		"-p, --project <id-or-slug>",
		"Target a specific project (default: your default-write project)",
	)
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault import .env.production\n  $ clawdi vault import .env.staging --project engineering --yes",
	)
	.action(async (file, opts) => {
		const { vaultImport } = await import("./commands/vault.js");
		await vaultImport(file, { ...opts, project: opts.project });
	});

vaultCmd
	.command("resolve <key>")
	.description("Resolve one vault key")
	.option(
		"-p, --project <project>",
		"Project to resolve from (default: your default-write project)",
	)
	.option("--debug", "Show project precedence and skipped matches")
	.option("--json", "Output the full resolve response as JSON")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ clawdi vault resolve OPENAI_API_KEY                       # default-write project\n" +
			"  $ clawdi vault resolve OPENAI_API_KEY --project personal --debug",
	)
	.action(async (key, opts) => {
		const { vaultResolveCommand } = await import("./commands/vault-resolve.js");
		await vaultResolveCommand(key, { ...opts, project: opts.project });
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
		"Upload to a specific agent's primary project (claude_code, codex, hermes, openclaw)",
	)
	.option(
		"-p, --project <id-or-slug>",
		"Upload to an explicit project (UUID, slug, or name). Mutex with --agent.",
	)
	.option("-y, --yes", "Skip the confirmation prompt")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi skill add ./my-skill                         # default-write project\n  $ clawdi skill add ./my-skill --project engineering   # explicit project\n  $ clawdi skill add ./my-skill --agent codex            # an agent's primary project",
	)
	.action(async (path, opts) => {
		const { skillAdd } = await import("./commands/skill.js");
		await skillAdd(path, { ...opts, project: opts.project });
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
		"Remove from a specific agent's primary project (claude_code, codex, hermes, openclaw)",
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

const projectCmd = program.command("project").description("Manage your projects and sharing");

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
	.description("List projects you can access")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.action(async (opts: { json?: boolean }) => {
		const { projectListCommand } = await import("./commands/project-list.js");
		await projectListCommand(opts);
	});

projectCmd
	.command("show <project>")
	.description("Show project metadata and owned content counts")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.action(async (project: string, opts: { json?: boolean }) => {
		const { projectShowCommand } = await import("./commands/project-show.js");
		await projectShowCommand(project, opts);
	});

projectCmd
	.command("share [project]")
	.description("Generate a share link. Defaults to your write project when [project] is omitted.")
	.option("-l, --label <text>", "Optional label shown in the share-links list")
	.action(async (project: string | undefined, opts: { label?: string }) => {
		const { projectShareCommand } = await import("./commands/project-share.js");
		await projectShareCommand(project, opts);
	});

projectCmd
	.command("share-links <project>")
	.description("List or revoke share links on a project")
	.option("--revoke <id-or-prefix>", "Revoke a specific link")
	.action(async (project: string, opts: { revoke?: string }) => {
		const { projectShareLinksCommand } = await import("./commands/project-share-links.js");
		await projectShareLinksCommand(project, opts);
	});

projectCmd
	.command("invite <project>")
	.description("Send an email invitation to a registered clawdi user")
	.requiredOption("-e, --email <addr>", "Email address to invite")
	.action(async (project: string, opts: { email: string }) => {
		const { projectInviteCommand } = await import("./commands/project-invite.js");
		await projectInviteCommand(project, opts);
	});

projectCmd
	.command("invites <project>")
	.description("List pending invitations on a project you own.")
	.option("--cancel <id>", "Cancel one of the pending invitations on this project")
	.addHelpText(
		"after",
		"\n  Sharee side (listing / accepting / declining invitations addressed to you)\n" +
			"  lives under `clawdi inbox`.",
	)
	.action(async (project: string, opts: { cancel?: string }) => {
		const { projectInvitesCommand } = await import("./commands/project-invites.js");
		await projectInvitesCommand(project, opts);
	});

projectCmd
	.command("members <project>")
	.description("List or remove accepted members on a project you own")
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
	.description("Leave a shared project")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText("after", "\nExample:\n  $ clawdi project leave @alice-cdbf/engineering")
	.action(async (project: string, opts: { json?: boolean }) => {
		const { projectLeaveCommand } = await import("./commands/project-members.js");
		await projectLeaveCommand(project, opts);
	});

projectCmd
	.command("unshare <project>")
	.description("Owner: revoke links, cancel invitations, and remove all members")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText("after", "\nExample:\n  $ clawdi project unshare engineering")
	.action(async (project: string, opts: { json?: boolean }) => {
		const { projectUnshareCommand } = await import("./commands/project-members.js");
		await projectUnshareCommand(project, opts);
	});

const scopeCmd = program
	.command("scope", { hidden: true })
	.description("Compatibility alias for project commands")
	.showHelpAfterError();

scopeCmd
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

scopeCmd
	.command("list")
	.description("List projects you can access")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.action(async (opts: { json?: boolean }) => {
		const { projectListCommand } = await import("./commands/project-list.js");
		await projectListCommand(opts);
	});

scopeCmd
	.command("show <scope>")
	.description("Show project metadata and owned content counts")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.action(async (scope: string, opts: { json?: boolean }) => {
		const { projectShowCommand } = await import("./commands/project-show.js");
		await projectShowCommand(scope, opts);
	});

scopeCmd
	.command("share [scope]")
	.description("Generate a share link. Defaults to your write project when [project] is omitted.")
	.option("-l, --label <text>", "Optional label shown in the share-links list")
	.action(async (scope: string | undefined, opts: { label?: string }) => {
		const { projectShareCommand } = await import("./commands/project-share.js");
		await projectShareCommand(scope, opts);
	});

scopeCmd
	.command("share-links <scope>")
	.description("List or revoke share links on a project")
	.option("--revoke <id-or-prefix>", "Revoke a specific link")
	.action(async (scope: string, opts: { revoke?: string }) => {
		const { projectShareLinksCommand } = await import("./commands/project-share-links.js");
		await projectShareLinksCommand(scope, opts);
	});

scopeCmd
	.command("invite <scope>")
	.description("Send an email invitation to a registered clawdi user")
	.requiredOption("-e, --email <addr>", "Email address to invite")
	.action(async (scope: string, opts: { email: string }) => {
		const { projectInviteCommand } = await import("./commands/project-invite.js");
		await projectInviteCommand(scope, opts);
	});

scopeCmd
	.command("invites <scope>")
	.description("List pending invitations on a project you own.")
	.option("--cancel <id>", "Cancel one of the pending invitations on this project")
	.addHelpText(
		"after",
		"\n  Sharee side (listing / accepting / declining invitations addressed to you)\n" +
			"  lives under `clawdi inbox`.",
	)
	.action(async (scope: string, opts: { cancel?: string }) => {
		const { projectInvitesCommand } = await import("./commands/project-invites.js");
		await projectInvitesCommand(scope, opts);
	});

scopeCmd
	.command("members <scope>")
	.description("List or remove accepted members on a project you own")
	.option("--remove <email-or-user-id>", "Remove one accepted member")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText(
		"after",
		"\nExample:\n  $ clawdi project members engineering --remove bob@example.com",
	)
	.action(async (scope: string, opts: { remove?: string; json?: boolean }) => {
		const { projectMembersCommand } = await import("./commands/project-members.js");
		await projectMembersCommand(scope, opts);
	});

scopeCmd
	.command("leave <scope>")
	.description("Leave a shared project")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText("after", "\nExample:\n  $ clawdi project leave @alice-cdbf/engineering")
	.action(async (scope: string, opts: { json?: boolean }) => {
		const { projectLeaveCommand } = await import("./commands/project-members.js");
		await projectLeaveCommand(scope, opts);
	});

scopeCmd
	.command("unshare <scope>")
	.description("Owner: revoke links, cancel invitations, and remove all members")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText("after", "\nExample:\n  $ clawdi project unshare engineering")
	.action(async (scope: string, opts: { json?: boolean }) => {
		const { projectUnshareCommand } = await import("./commands/project-members.js");
		await projectUnshareCommand(scope, opts);
	});

const agentCmd = program.command("agent").description("Manage agents");
const agentProjectsCmd = agentCmd
	.command("projects")
	.description("Manage project bindings for an agent");

agentProjectsCmd
	.command("list <agent-id>")
	.description("List project bindings for an agent")
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.action(async (agentId, opts) => {
		const { agentProjectsListCommand } = await import("./commands/agent-projects.js");
		await agentProjectsListCommand(agentId, opts);
	});

agentProjectsCmd
	.command("set-primary <agent-id>")
	.description("Set the agent's primary project")
	.requiredOption("-p, --project <id-or-slug>", "Project UUID, slug, or name")
	.action(async (agentId, opts) => {
		const { agentProjectsSetPrimaryCommand } = await import("./commands/agent-projects.js");
		await agentProjectsSetPrimaryCommand(agentId, opts);
	});

agentProjectsCmd
	.command("add-context <agent-id>")
	.description("Add a context project binding to an agent")
	.requiredOption("-p, --project <id-or-slug>", "Project UUID, slug, or name")
	.option("--priority <n>", "Optional priority (>=1)")
	.action(async (agentId, opts) => {
		const { agentProjectsAddContextCommand } = await import("./commands/agent-projects.js");
		await agentProjectsAddContextCommand(agentId, opts);
	});

agentProjectsCmd
	.command("remove-context <agent-id>")
	.description("Remove a context project binding from an agent")
	.requiredOption("-p, --project <id-or-slug>", "Project UUID, slug, or name")
	.action(async (agentId, opts) => {
		const { agentProjectsRemoveContextCommand } = await import("./commands/agent-projects.js");
		await agentProjectsRemoveContextCommand(agentId, opts);
	});

// ─────────────────────────────────────────────────────────────
// inbox — incoming invitations and share URLs awaiting my action.
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
	.option(
		"-a, --agent <agent-id>",
		"Bind the accepted project to one or more agents (repeat or comma-separate)",
		collectCsvValues,
		[] as string[],
	)
	.option(
		"--bind-as <context|primary>",
		"Binding type used with --agent (default: context)",
		"context",
	)
	.option("--json", "Emit machine-readable JSON (agent contract)")
	.addHelpText(
		"after",
		`
Examples:
  Human-friendly (polymorphic):
    $ clawdi inbox accept https://clawdi.ai/share/abc...
    $ clawdi inbox accept 1a2b3c4d-...    # invitation id

  Agent-blessed (explicit):
    $ clawdi inbox accept --url <link> --agent <agent-id>
    $ clawdi inbox accept --invite <id> --agent <agent-id> --bind-as context`,
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
