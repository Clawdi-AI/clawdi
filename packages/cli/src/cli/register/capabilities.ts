import type { Command } from "commander";

export function registerCapabilities(program: Command): void {
	program
		.command("capabilities", { hidden: true })
		.description("Show CLI feature surface and hosted policy restrictions")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { capabilitiesCommand } = await import("../../commands/capabilities.js");
			await capabilitiesCommand(
				opts,
				program.commands.map((command) => command.name()),
			);
		});
}
