import { type Command, Option } from "commander";
import { AGENT_TYPE_HELP_LABEL } from "../../adapters/registry.js";
import { parsePositiveInteger } from "../../lib/cli-options.js";
import { collectValues } from "../option-values.js";

export function registerAgent(program: Command): void {
	const agentCmd = program.command("agent").description("Manage agents");

	agentCmd
		.command("list")
		.description("List your agents and their last activity")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { agentList } = await import("../../commands/agent.js");
			await agentList(opts);
		});

	agentCmd
		.command("rm <agent-id>")
		.description("Disconnect a local agent or delete a Cloud Agent and its saved data")
		.option("-y, --yes", "Confirm removal without prompting")
		.option("--cancel-subscription", "Cancel the Cloud Agent subscription when deleting")
		.option("--keep-subscription", "Keep the Cloud Agent subscription for a future agent")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nUse the agent UUID printed by `clawdi agent list`. Renewing subscriptions require a choice.\nExample: clawdi agent rm <agent-id> --yes --cancel-subscription --json",
		)
		.action(
			async (
				id: string,
				opts: {
					yes?: boolean;
					json?: boolean;
					cancelSubscription?: boolean;
					keepSubscription?: boolean;
				},
			) => {
				const { agentRm } = await import("../../commands/agent.js");
				await agentRm(id, opts);
			},
		);

	for (const action of ["start", "stop", "restart"] as const) {
		agentCmd
			.command(`${action} <agent-id>`)
			.description(
				`${action[0]?.toUpperCase()}${action.slice(1)} a Cloud Agent and wait for completion`,
			)
			.option("--json", "Output as JSON")
			.option("--no-wait", "Return when the operation is accepted")
			.addHelpText(
				"after",
				`\nUse the agent UUID printed by \`clawdi agent list\`.\nExample: clawdi agent ${action} <agent-id> --json`,
			)
			.action(async (id: string, opts: { json?: boolean; wait?: boolean }) => {
				const { agentLifecycle } = await import("../../commands/agent-lifecycle.js");
				await agentLifecycle(action, id, opts);
			});
	}

	const agentPluginsCmd = agentCmd.command("plugins").description("Manage Cloud Agent plugins");
	agentPluginsCmd
		.command("list <agent-id>")
		.description("List requested plugins and observed convergence")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample: clawdi agent plugins list <agent-id> --json")
		.action(async (id: string, opts: { json?: boolean }) => {
			const { agentPluginsList } = await import("../../commands/agent-plugins.js");
			await agentPluginsList(id, opts);
		});
	agentPluginsCmd
		.command("install <agent-id> [plugin-name]")
		.description("Request a catalog plugin installation; omit the name for choices")
		.option("--plugin-version <version>", "Exact plugin catalog version")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample: clawdi agent plugins install <agent-id> <plugin-name> --json")
		.action(
			async (
				id: string,
				name: string | undefined,
				opts: { json?: boolean; pluginVersion?: string },
			) => {
				const { agentPluginsInstall } = await import("../../commands/agent-plugins.js");
				await agentPluginsInstall(id, name, opts);
			},
		);
	agentPluginsCmd
		.command("rm <agent-id> <plugin-name>")
		.description("Request removal of an agent plugin")
		.option("-y, --yes", "Confirm removal without prompting")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExample: clawdi agent plugins rm <agent-id> <plugin-name> --yes --json",
		)
		.action(async (id: string, name: string, opts: { json?: boolean; yes?: boolean }) => {
			const { agentPluginsRemove } = await import("../../commands/agent-plugins.js");
			await agentPluginsRemove(id, name, opts);
		});

	const agentSkillsCmd = agentCmd
		.command("skills")
		.description("Manage remote Cloud Agent skills (not local --agent types)");
	agentSkillsCmd
		.command("list <agent-id>")
		.description("List remote desired skills, capabilities and observed convergence")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ clawdi agent skills list <agent-id> --json")
		.action(async (id, opts) => {
			const { agentSkillsList } = await import("../../commands/agent-skills.js");
			await agentSkillsList(id, opts);
		});
	agentSkillsCmd
		.command("read <agent-id> <skill-key>")
		.description("Read remote skill detail using its exact inventory key")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ clawdi agent skills read <agent-id> review/SKILL.md")
		.action(async (id, key, opts) => {
			const { agentSkillsRead } = await import("../../commands/agent-skills.js");
			await agentSkillsRead(id, key, opts);
		});
	agentSkillsCmd
		.command("install <agent-id>")
		.description("Request a public GitHub skill or library reference; inspect list for application")
		.option("--github <repo>", "Public GitHub owner/repo or URL")
		.option("--path <directory>", "Skill directory within the GitHub repository")
		.option("--library <skill-id>", "Library skill UUID")
		.option("--request-id <uuid>", "GitHub mutation idempotency key (generated if omitted)")
		.option(
			"--resource-version <version>",
			"Original resource version for exact replay with --request-id",
		)
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi agent skills install <agent-id> --github owner/repo --path skills/review\n  $ clawdi agent skills install <agent-id> --library <skill-id>",
		)
		.action(async (id, opts) => {
			const { agentSkillsInstall } = await import("../../commands/agent-skills.js");
			await agentSkillsInstall(id, opts);
		});
	agentSkillsCmd
		.command("rm <agent-id> <skill-key>")
		.description(
			"Request removal by exact remote inventory key; linked/bundled skills are read-only",
		)
		.option("--request-id <uuid>", "GitHub mutation idempotency key (generated if omitted)")
		.option(
			"--resource-version <version>",
			"Original resource version for exact replay with --request-id",
		)
		.option("-y, --yes", "Confirm remote skill removal without prompting")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ clawdi agent skills rm <agent-id> review/SKILL.md --yes")
		.action(async (id, key, opts) => {
			const { agentSkillsRemove } = await import("../../commands/agent-skills.js");
			await agentSkillsRemove(id, key, opts);
		});

	agentCmd
		.command("detect")
		.description("Detect supported local agents without changing them")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { agentDetectCommand } = await import("../../commands/agent-detect.js");
			await agentDetectCommand(opts);
		});

	agentCmd
		.command("reconnect [agent-id]")
		.description("Recover a local agent binding without creating a new cloud identity")
		.option("--agent <type>", `Agent type (${AGENT_TYPE_HELP_LABEL})`)
		.option("-y, --yes", "Skip confirmation when the target is unambiguous")
		.option("--confirm-takeover", "Confirm disconnecting a recently active installation")
		.option("--no-daemon", "Skip installing/starting background sync daemons")
		.addOption(new Option("--desktop-list").hideHelp())
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi agent reconnect --agent codex\n  $ clawdi agent reconnect <agent-id>\n  $ clawdi agent reconnect <agent-id> --no-daemon",
		)
		.action(async (agentId: string | undefined, opts) => {
			const { agentReconnect } = await import("../../commands/agent-reconnect.js");
			await agentReconnect(agentId, opts);
		});

	const agentCredentialsCmd = agentCmd
		.command("credentials")
		.description("Sync local CLI credential profiles");

	agentCredentialsCmd
		.command("import <tool>")
		.description("Import a personal local CLI credential profile into Clawdi vault")
		.option("-p, --project <id-or-slug>", "Target a specific project")
		.option("--profile <name>", "Profile name", "default")
		.option("--source <source>", "Credential source: file or keychain", "file")
		.option("--from <path>", "Credential file to import (required for tools without an adapter)")
		.option("--to <path>", "Materialization target path to store with the profile")
		.option("--keychain-service <service>", "macOS Keychain service name for --source keychain")
		.option("--keychain-account <account>", "macOS Keychain account name for --source keychain")
		.option("-y, --yes", "Skip confirmation (required in a non-interactive shell)")
		.option("--dry-run", "Show what would be imported without storing anything")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Examples:
  $ clawdi agent credentials import claude-code
  $ clawdi agent credentials import claude-code --source keychain --keychain-service <service> --keychain-account <account>
  $ clawdi agent credentials import gh
  $ clawdi agent credentials import aws --from ~/.aws/credentials --to ~/.aws/credentials --yes

Codex model-provider auth:
  $ clawdi ai-provider import-auth openai-codex --tool codex --yes`,
		)
		.action(async (tool: string, opts) => {
			const { agentCredentialsImportCommand } = await import("../../commands/agent-credentials.js");
			await agentCredentialsImportCommand(tool, opts);
		});

	agentCredentialsCmd
		.command("materialize <tool>")
		.description("Recreate a personal local CLI credential profile on this machine")
		.option("-p, --project <id-or-slug>", "Read from a specific project")
		.option("--profile <name>", "Profile name", "default")
		.option("--to <path>", "Override destination path (only for single-file profiles)")
		.option("-y, --yes", "Skip confirmation (required in a non-interactive shell)")
		.option("--no-backup", "Overwrite existing files without creating .bak-* copies")
		.option("--dry-run", "Show what would be written without changing files")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Examples:
  $ clawdi agent credentials materialize claude-code
  $ clawdi agent credentials materialize gh
  $ clawdi agent credentials materialize aws --profile work --to ~/.aws/credentials --yes`,
		)
		.action(async (tool: string, opts) => {
			const { agentCredentialsMaterializeCommand } = await import(
				"../../commands/agent-credentials.js"
			);
			await agentCredentialsMaterializeCommand(tool, opts);
		});

	const agentProjectsCmd = agentCmd
		.command("projects")
		.description("View workspace and linked projects");

	agentProjectsCmd
		.command("list <agent-id>")
		.description("Show workspace and linked-project vault priority")
		.option("--json", "Output as JSON")
		.action(async (agentId, opts) => {
			const { agentProjectsListCommand } = await import("../../commands/agent-projects.js");
			await agentProjectsListCommand(agentId, opts);
		});

	agentProjectsCmd
		.command("link <agent-id>")
		.alias("attach")
		.description("Link a project for vault resolution")
		.requiredOption("-p, --project <id-or-slug>", "Project UUID, slug, name, or @owner/slug")
		.option("--order <n>", "Vault resolution priority (>=1)", parsePositiveInteger)
		.option("--json", "Output as JSON")
		.action(async (agentId, opts) => {
			const { agentProjectsAddContextCommand } = await import("../../commands/agent-projects.js");
			await agentProjectsAddContextCommand(agentId, opts);
		});

	agentProjectsCmd
		.command("unlink <agent-id>")
		.alias("detach")
		.description("Unlink a project from vault resolution")
		.requiredOption("-p, --project <id-or-slug>", "Project UUID, slug, name, or @owner/slug")
		.option("-y, --yes", "Skip the interactive confirmation prompt")
		.addHelpText(
			"after",
			"\nExample:\n  $ clawdi agent projects unlink <agent-id> --project engineering --yes",
		)
		.option("--json", "Output as JSON")
		.action(async (agentId, opts) => {
			const { agentProjectsRemoveContextCommand } = await import(
				"../../commands/agent-projects.js"
			);
			await agentProjectsRemoveContextCommand(agentId, opts);
		});

	agentProjectsCmd
		.command("move <agent-id>")
		.description("Update vault resolution priority")
		.option(
			"--item <id:order>",
			"Linked project relation ID and target vault priority (repeatable)",
			collectValues,
			[] as string[],
		)
		.addHelpText(
			"after",
			"\nExample:\n  $ clawdi agent projects move <agent-id> --item <id>:1 --item <id>:2",
		)
		.option("--json", "Output as JSON")
		.action(async (agentId, opts) => {
			const { agentProjectsReorderCommand } = await import("../../commands/agent-projects.js");
			await agentProjectsReorderCommand(agentId, opts);
		});
}
