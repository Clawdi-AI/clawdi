import type { Command } from "commander";

export function registerInject(program: Command): void {
	program
		.command("inject")
		.description("Render clawdi:// references in a template")
		.option("--in <file>", "Input template path, or - for stdin", "-")
		.option("--out <file>", "Output path, or - for stdout", "-")
		.option("--force", "Overwrite an existing output file")
		.option("-p, --project <project>", "Project to resolve from")
		.option("-a, --agent <agent-id-or-type>", "Resolve through workspace and linked projects")
		.option(
			"--allow-conflicts",
			"Allow first-match wins for workspace and linked-project vault conflicts",
		)
		.option("--no-project-folder", "Skip linked-folder project lookup")
		.option("--dry-run", "Show references that would resolve without writing output")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ clawdi inject --dry-run --in .env.clawdi --out .env.local\n" +
				"  $ clawdi inject --force --in .env.clawdi --out .env.local\n" +
				"  $ clawdi inject --in config.template.json --out -",
		)
		.action(async (opts) => {
			const { injectCommand } = await import("../../commands/inject.js");
			await injectCommand({ ...opts, project: opts.project });
		});
}
