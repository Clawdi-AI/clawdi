import type { Command } from "commander";
import { SKILL_AGENT_TYPE_HELP_LABEL } from "../../adapters/registry.js";

export function registerSkill(program: Command): void {
	const skillCmd = program.command("skill").description("Manage skills");

	skillCmd
		.command("show <key>")
		.description("Read a skill without importing it")
		.option("-p, --project <id-or-slug>", "Target project (default: your default-write project)")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ clawdi skill show my-skill --project engineering --json")
		.action(async (id: string, opts) => {
			const { skillShow } = await import("../../commands/skill.js");
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
			const { skillList } = await import("../../commands/skill.js");
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
			const { skillAdd } = await import("../../commands/skill.js");
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
			const { skillInstall } = await import("../../commands/skill.js");
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
			const { skillRm } = await import("../../commands/skill.js");
			await skillRm(key, opts);
		});

	skillCmd
		.command("init [name]")
		.description("Scaffold a new SKILL.md template in the current or named directory")
		.addHelpText("after", "\nExamples:\n  $ clawdi skill init\n  $ clawdi skill init my-skill")
		.action(async (name) => {
			const { skillInit } = await import("../../commands/skill.js");
			skillInit(name);
		});
}
