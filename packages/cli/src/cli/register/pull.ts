import type { Command } from "commander";
import { AGENT_TYPE_HELP_LABEL } from "../../adapters/registry.js";

export function registerPull(program: Command): void {
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
		.option(
			"--dry-run",
			"Preview session mirrors or explicit skill imports without writing locally",
		)
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
			const { pull } = await import("../../commands/pull.js");
			await pull(opts);
		});
}
