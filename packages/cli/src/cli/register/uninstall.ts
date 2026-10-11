import type { Command } from "commander";

export function registerUninstall(program: Command): void {
	program
		.command("uninstall")
		.description("Remove local Clawdi services, integrations, sign-in, and state")
		.option("--remove-cli", "Also remove a native CLI installation (npm and Homebrew are kept)")
		.option("-y, --yes", "Skip the confirmation prompt")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nAccount data stays. Native CLIs installed by Desktop are removed automatically.\n\nExamples:\n  $ clawdi uninstall\n  $ clawdi uninstall --remove-cli --yes --json",
		)
		.action(async (opts) => {
			const { uninstall } = await import("../../commands/uninstall.js");
			await uninstall(opts);
		});
}
