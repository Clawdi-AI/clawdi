import type { Command } from "commander";
import { AGENT_TYPE_HELP_LABEL } from "../../adapters/registry.js";

export function registerPush(program: Command): void {
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
			const { push } = await import("../../commands/push.js");
			await push(opts);
		});
}
