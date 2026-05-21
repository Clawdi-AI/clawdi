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
  $ clawdi setup                    Detect agents and register the current machine
  $ clawdi session list             Preview local sessions before pushing
  $ clawdi push --all               Upload everything (every agent, project, module)
  $ clawdi pull --all               Download everything from the cloud
  $ clawdi skill list --json        Machine-readable skill listing
  $ clawdi memory search "redis"    Search memories by text
  $ clawdi vault set OPENAI_API_KEY Store a secret
  $ clawdi project folder link --project engineering  Use this folder with a Project
  $ clawdi run --env-file .env.clawdi -- npm run dev  Resolve clawdi:// refs at runtime

Environment:
  CLAWDI_API_URL           Override the Clawdi Cloud API endpoint
  CLAWDI_DEBUG             Print stack traces on error
  CLAWDI_NO_UPDATE_CHECK   Suppress the non-blocking update check
  CLAWDI_NO_AUTO_UPDATE    Skip CLI/daemon background auto-update (also disables via \`config set autoUpdate false\`)
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
	.option("-y, --yes", "Skip confirmation prompts")
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
// vault
// ─────────────────────────────────────────────────────────────
const vaultCmd = program
	.command("vault")
	.description("Manage secrets")
	.addHelpText(
		"after",
		`
Scope:
  Write commands (set/import/rm) use --project first; otherwise they write to
  your default-write project. The selected project is printed before writing.
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
	.command("rm <key>")
	.alias("delete")
	.description("Delete a secret")
	.option(
		"-p, --project <id-or-slug>",
		"Target a specific project (default: your default-write project)",
	)
	.option("-y, --yes", "Skip the confirmation prompt")
	.addHelpText(
		"after",
		"\nExamples:\n  $ clawdi vault rm OPENAI_API_KEY\n  $ clawdi vault delete prod/stripe/SECRET_KEY --project engineering --yes",
	)
	.action(async (key, opts) => {
		const { vaultRm } = await import("./commands/vault.js");
		await vaultRm(key, { ...opts, project: opts.project, yes: opts.yes });
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
	.option("-l, --list", "List skills in the repo without installing (planned)")
	.option("-y, --yes", "Skip confirmation prompts")
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
	.description("Create a read-only project share link")
	.option("-l, --label <text>", "Optional label shown in the share-links list")
	.action(async (project: string | undefined, opts: { label?: string }) => {
		const { projectShareCommand } = await import("./commands/project-share.js");
		await projectShareCommand(project, opts);
	});

projectCmd
	.command("share-links <project>")
	.description("List or revoke read-only project links")
	.option("--revoke <id-or-prefix>", "Revoke a specific link")
	.action(async (project: string, opts: { revoke?: string }) => {
		const { projectShareLinksCommand } = await import("./commands/project-share-links.js");
		await projectShareLinksCommand(project, opts);
	});

projectCmd
	.command("invite <project>")
	.description("Invite a person to read-only project access")
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
  $ clawdi agent credentials import codex
  $ clawdi agent credentials import claude-code
  $ clawdi agent credentials import claude-code --source keychain --keychain-service <service> --keychain-account <account>
  $ clawdi agent credentials import gh
  $ clawdi agent credentials import aws --from ~/.aws/credentials --to ~/.aws/credentials`,
	)
	.action(async (tool: string, opts) => {
		const { agentCredentialsImportCommand } = await import("./commands/agent-credentials.js");
		await agentCredentialsImportCommand(tool, opts);
	});

agentCredentialsCmd
	.command("materialize <tool>")
	.description("Restore a personal local CLI credential profile on this machine")
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
  $ clawdi agent credentials materialize codex
  $ clawdi agent credentials materialize claude-code
  $ clawdi agent credentials materialize gh
  $ clawdi agent credentials materialize aws --profile work --to ~/.aws/credentials`,
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
	.description("Accept read-only project access from an invite or share link")
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
