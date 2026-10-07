import type { Command } from "commander";

export function registerDoctor(program: Command): void {
	program
		.command("doctor")
		.description("Diagnose auth, agents, vault, and MCP connectivity")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExamples:\n  $ clawdi doctor\n  $ clawdi doctor --json")
		.action(async (opts) => {
			const { doctor } = await import("../../commands/doctor.js");
			await doctor(opts);
		});
}
