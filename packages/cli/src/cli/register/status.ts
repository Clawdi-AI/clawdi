import type { Command } from "commander";

export function registerStatus(program: Command): void {
	program
		.command("status")
		.description("Show current auth and module activity")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExamples:\n  $ clawdi status\n  $ clawdi status --json")
		.action(async (opts) => {
			const { status } = await import("../../commands/status.js");
			await status(opts);
		});
}
