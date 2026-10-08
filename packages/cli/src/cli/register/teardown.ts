import type { Command } from "commander";
import { AGENT_TYPE_HELP_LABEL } from "../../adapters/registry.js";

export function registerTeardown(program: Command): void {
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
  $ clawdi teardown --agent claude_code --yes
  $ clawdi teardown --all --yes
  $ clawdi teardown --agent hermes --keep-skill

Teardown in a non-interactive shell requires --yes.`,
		)
		.option("--json", "Output as JSON")
		.action(async (opts) => {
			const { teardown } = await import("../../commands/teardown.js");
			await teardown(opts);
		});
}
