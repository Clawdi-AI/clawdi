import type { Command } from "commander";
import { AGENT_TYPE_HELP_LABEL } from "../../adapters/registry.js";

export function registerSetup(program: Command): void {
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
		.option(
			"--exclude-project <path>",
			"Exclude project paths before the first upload (comma-separated; repeatable)",
			(value: string, paths: string[]) => [...paths, value],
			[],
		)
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi setup\n  $ clawdi setup --yes\n  $ clawdi setup --agent claude_code\n  $ clawdi setup --no-daemon",
		)
		.option("--json", "Output as JSON")
		.action(async (opts) => {
			const { setup } = await import("../../commands/setup.js");
			await setup(opts);
		});
}
