import type { Command } from "commander";

export function registerRead(program: Command): void {
	program
		.command("read")
		.description("Read one clawdi:// secret reference")
		.argument("<reference>", "Reference to read")
		.option("-p, --project <project>", "Project to resolve from")
		.option("-a, --agent <agent-id-or-type>", "Resolve through workspace and linked projects")
		.option(
			"--allow-conflicts",
			"Allow first-match wins for workspace and linked-project vault conflicts",
		)
		.option("--debug", "Show project precedence without printing secrets in diagnostics")
		.option("--dry-run", "Check the reference without printing the plaintext value")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ clawdi read clawdi://project/<project-id>/vault/prod/section/stripe/field/secret_key\n" +
				"  $ clawdi read clawdi://prod/db/url --project engineering --json",
		)
		.action(async (reference, opts) => {
			const { readCommand } = await import("../../commands/read.js");
			await readCommand(reference, { ...opts, project: opts.project });
		});
}
