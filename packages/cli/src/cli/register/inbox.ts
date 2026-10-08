import type { Command } from "commander";

function collectCsvValues(value: string, prev: string[] = []): string[] {
	const values = value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	return prev.concat(values);
}

export function registerInbox(program: Command): void {
	const inboxCmd = program
		.command("inbox")
		.description("Incoming project invites and share links")
		.option("--json", "Output as JSON")
		.action(async (opts) => {
			// `clawdi inbox` (no subcommand) → list pending invitations
			const { inboxListCommand } = await import("../../commands/inbox.js");
			await inboxListCommand(opts);
		});

	inboxCmd
		.command("accept [id-or-url]")
		.description("Accept an invitation, or stage/join a share link based on auth state")
		.option("--invite <id>", "Explicit invitation UUID (bypass shape detection)")
		.option("--url <link>", "Explicit share URL (bypass shape detection)")
		.option(
			"-a, --agent <agent-id>",
			"Link the accepted project to one or more agents (repeat or comma-separate)",
			collectCsvValues,
			[] as string[],
		)
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Examples:
  Human-friendly (polymorphic):
    $ clawdi inbox accept https://clawdi.ai/share/abc...
    $ clawdi inbox accept 1a2b3c4d-...    # invitation id

  Accept and link to agent:
    $ clawdi inbox accept --url <link> --agent <agent-id>
    $ clawdi inbox accept --invite <id> --agent <agent-id>`,
		)
		.action(async (idOrUrl, opts) => {
			const { inboxAcceptCommand } = await import("../../commands/inbox.js");
			await inboxAcceptCommand(idOrUrl, opts);
		});

	inboxCmd
		.command("join <project-id>")
		.description("Explicitly join one locally staged project share")
		.option(
			"-a, --agent <agent-id>",
			"Link the joined project to one or more agents (repeat or comma-separate)",
			collectCsvValues,
			[] as string[],
		)
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Example:
  $ clawdi auth login
  $ clawdi inbox join <project-id>
  $ clawdi pull --project <project-id>`,
		)
		.action(async (projectId, opts) => {
			const { inboxJoinCommand } = await import("../../commands/inbox.js");
			await inboxJoinCommand(projectId, opts);
		});

	inboxCmd
		.command("decline <id>")
		.description("Decline a pending invitation")
		.option("-y, --yes", "Skip the interactive confirmation prompt")
		.addHelpText("after", "\nExample:\n  $ clawdi inbox decline <id> --yes")
		.option("--json", "Output as JSON")
		.action(async (id, _opts, cmd) => {
			const { inboxDeclineCommand } = await import("../../commands/inbox.js");
			await inboxDeclineCommand(id, cmd.optsWithGlobals());
		});

	inboxCmd
		.command("forget <project-id>")
		.description("Local-only: remove a share record and its cached files")
		.option("-y, --yes", "Confirm removing the local share record")
		.option("--json", "Output as JSON")
		.action(async (projectId, _opts, cmd) => {
			const { inboxForgetCommand } = await import("../../commands/inbox.js");
			await inboxForgetCommand(projectId, cmd.optsWithGlobals());
		});
}
