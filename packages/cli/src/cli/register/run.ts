import { type Command, Option } from "commander";

export function registerRun(program: Command): void {
	program
		.command("run")
		.description("Run a command with clawdi:// references resolved")
		.option("-p, --project <id-or-slug>", "Resolve references from an explicit project")
		.option("-a, --agent <agent-id-or-type>", "Resolve through workspace and linked projects")
		.option(
			"--env-file <file>",
			"Load dotenv-like file and resolve clawdi:// references",
			(value, previous: string[]) => [...previous, value],
			[],
		)
		.option("--no-inherit-env", "Do not inherit the parent process environment")
		.option(
			"--allow-conflicts",
			"Allow first-match wins for workspace and linked-project vault conflicts",
		)
		.option("--no-project-folder", "Skip linked-folder project lookup")
		.option("--dry-run", "Show reference resolution plan without launching the command")
		.addOption(
			new Option(
				"--runtime-service <runtime+service>",
				"Run an internal hosted runtime service",
			).hideHelp(),
		)
		.argument("<command...>", "Command to run")
		.addHelpText(
			"after",
			`
Examples:
  $ clawdi project folder link --project engineering
  $ clawdi run --dry-run --env-file .env.clawdi -- npm run dev
  $ clawdi run --env-file .env.clawdi -- npm run dev
  ✓ Resolved 2 clawdi references

  $ clawdi run --project @alice/engineering --env-file .env.clawdi -- npm run dev
  $ clawdi run --no-project-folder -- python main.py

Scope resolution:
  Exact clawdi://project/... references carry their own project.
  Otherwise --project wins, then --agent, then linked folder, then default-write project.`,
		)
		.action(async (args, opts) => {
			const { run } = await import("../../commands/run.js");
			await run(args, opts);
		});
}
