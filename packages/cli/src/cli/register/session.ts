import type { Command } from "commander";
import { AGENT_TYPE_HELP_LABEL } from "../../adapters/registry.js";
import { parsePositiveInteger } from "../../lib/cli-options.js";

export function registerSession(program: Command): void {
	const sessionCmd = program
		.command("session")
		.description("Inspect local and uploaded agent sessions");

	sessionCmd
		.command("list")
		.description("List local agent sessions, or uploaded sessions with --uploaded")
		.option("--uploaded", "List sessions already uploaded to the cloud")
		.option("--agent <type>", `Single agent (${AGENT_TYPE_HELP_LABEL})`)
		.option("--agent-id <uuid>", "Filter uploaded sessions by Cloud Agent UUID")
		.option("--all-agents", "List sessions from every registered agent (default)")
		.option("--project <path>", "Restrict to one project path")
		.option("--all", "List sessions from all projects (default when --project not set)")
		.option("--since <date>", "Only list sessions started after this date")
		.option("--limit <n>", "Cap results", parsePositiveInteger, 100)
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Examples:
  $ clawdi session list
  $ clawdi session list --json
  $ clawdi session list --agent claude_code --project ~/work/foo
  $ clawdi session list --uploaded --agent-id <agent-uuid> --limit 10 --json`,
		)
		.action(async (opts) => {
			const { sessionList } = await import("../../commands/session.js");
			await sessionList(opts);
		});

	sessionCmd
		.command("search <query>")
		.description("Search uploaded session summaries, messages, projects, and IDs")
		.option("--agent <type>", "Filter by agent type")
		.option("--since <date>", "Only sessions active after this date")
		.option("--limit <n>", "Cap results (1-200)", parsePositiveInteger, 25)
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			'\nExamples:\n  $ clawdi session search authentication\n  $ clawdi session search "workspace setup" --agent codex --limit 10',
		)
		.action(async (query, opts) => {
			const { sessionSearch } = await import("../../commands/session.js");
			await sessionSearch(query, opts);
		});

	sessionCmd
		.command("read <session-id>")
		.description("Read one uploaded session and its message content")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi session read <session-id>\n  $ clawdi session read <session-id> --json\n\nUse the cloud session UUID printed by `clawdi session list --uploaded`.",
		)
		.action(async (sessionId, opts) => {
			const { sessionRead } = await import("../../commands/session.js");
			await sessionRead(sessionId, opts);
		});

	sessionCmd
		.command("rm <session-id>")
		.description("Permanently delete an uploaded session")
		.option("-y, --yes", "Confirm permanent deletion without prompting")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nUse the uploaded session UUID from `clawdi session list --uploaded` or `read`.",
		)
		.action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
			const { sessionRm } = await import("../../commands/session.js");
			await sessionRm(id, opts);
		});

	sessionCmd
		.command("export <session-id>")
		.description("Export an uploaded session as Markdown to stdout")
		.option("--json", "Output as JSON")
		.action(async (id, opts) => {
			const { sessionExport } = await import("../../commands/session.js");
			await sessionExport(id, opts);
		});

	sessionCmd
		.command("share <session-id>")
		.description("Publish an immutable public snapshot (user-level auth)")
		.option("-y, --yes", "Confirm public publication without prompting")
		.option("--through <position>", "Include messages through this zero-based position")
		.option(
			"--response <position>",
			"Share only the assistant response at this zero-based position",
		)
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi session share <session-id> --yes\n  $ clawdi session share <session-id> --through 4 --yes --json",
		)
		.action(async (id, opts) => {
			const { sessionShareCreate } = await import("../../commands/session.js");
			await sessionShareCreate(id, opts);
		});
	sessionCmd
		.command("shares [session-id]")
		.description("List active snapshot links")
		.option("--page <n>", "Page number", parsePositiveInteger, 1)
		.option("--limit <n>", "Page size (1-100)", parsePositiveInteger, 25)
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi session shares\n  $ clawdi session shares <session-id> --json",
		)
		.action(async (id, opts) => {
			const { sessionShareList } = await import("../../commands/session.js");
			await sessionShareList(id, opts);
		});
	sessionCmd
		.command("unshare <share-id>")
		.option("-y, --yes", "Confirm revocation without prompting")
		.description("Revoke the exact snapshot link ID from session shares")
		.option("--json", "Output as JSON")
		.action(async (id, opts) => {
			const { sessionShareRevoke } = await import("../../commands/session.js");
			await sessionShareRevoke(id, opts);
		});

	sessionCmd
		.command("extract <session-id>")
		.description("Extract memories from a session via the cloud's configured LLM")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Examples:
  $ clawdi session extract a1b2c3d4-...
  $ clawdi session extract a1b2c3d4-... --json
  # Loop the recent 10 sessions (the onboarding skill does this):
  $ clawdi session list --limit 10 --json | \\
      jq -r '.[].id' | \\
      xargs -I{} clawdi session extract {} --json`,
		)
		.action(async (sessionId, opts) => {
			const { sessionExtract } = await import("../../commands/session.js");
			await sessionExtract(sessionId, opts);
		});
}
