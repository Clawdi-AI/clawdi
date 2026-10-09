import type { Command } from "commander";
import { parsePositiveInteger } from "../../lib/cli-options.js";
import { collectValues } from "../option-values.js";

export function registerChannel(program: Command): void {
	const channelCmd = program
		.command("channel")
		.description("Manage channel bots and pair external chats to agents");

	channelCmd
		.command("unpair <channel-id>")
		.description("Unpair a chat from a channel")
		.requiredOption("--binding <binding-id>", "Chat binding UUID to unpair")
		.option("-y, --yes", "Confirm unpairing the chat")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExample:\n  $ clawdi channel unpair <channel-id> --binding <binding-id> --yes --json",
		)
		.action(async (id: string, opts) => {
			const { channelUnpairCommand } = await import("../../commands/channel.js");
			await channelUnpairCommand(id, opts);
		});

	channelCmd
		.command("unlink <channel-id>")
		.description("Unlink an agent from a channel")
		.requiredOption("--link <link-id>", "Agent link UUID to unlink")
		.option("-y, --yes", "Confirm unlinking the agent")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExample:\n  $ clawdi channel unlink <channel-id> --link <link-id> --yes --json",
		)
		.action(async (id: string, opts) => {
			const { channelUnlinkCommand } = await import("../../commands/channel.js");
			await channelUnlinkCommand(id, opts);
		});

	channelCmd
		.command("list")
		.description("List your private channel bots")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { channelListCommand } = await import("../../commands/channel.js");
			await channelListCommand(opts);
		});

	channelCmd
		.command("available")
		.description("List available channel bots")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { channelAvailableCommand } = await import("../../commands/channel.js");
			await channelAvailableCommand(opts);
		});

	channelCmd
		.command("get <channel-id>")
		.description("Show channel bot details")
		.option("--json", "Output as JSON")
		.action(async (channelId: string, opts: { json?: boolean }) => {
			const { channelGetCommand } = await import("../../commands/channel.js");
			await channelGetCommand(channelId, opts);
		});

	channelCmd
		.command("create <provider> <name>")
		.description("Create a private channel bot")
		.option("--agent <agent-id>", "Create an initial bot-agent link")
		.option("--provider-token <token>", "Provider token or upstream credential")
		.option("--provider-token-env <name>", "Read provider token from an env var")
		.option("--config <json>", "Provider config JSON object")
		.option("--secret <name=value>", "Encrypted provider secret; repeatable", collectValues)
		.option(
			"--secret-env <name=env>",
			"Encrypted provider secret read from an env var; repeatable",
			collectValues,
		)
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExample:\n  $ TELEGRAM_BOT_TOKEN=123:abc clawdi channel create telegram ops-bot --agent <agent-id> --provider-token-env TELEGRAM_BOT_TOKEN",
		)
		.action(async (provider: string, name: string, opts) => {
			const { channelCreateCommand } = await import("../../commands/channel.js");
			await channelCreateCommand(provider, name, opts);
		});

	channelCmd
		.command("links <channel-id>")
		.description("List your bot-agent links for a channel")
		.option("--json", "Output as JSON")
		.action(async (channelId: string, opts: { json?: boolean }) => {
			const { channelLinksCommand } = await import("../../commands/channel.js");
			await channelLinksCommand(channelId, opts);
		});

	channelCmd
		.command("link <channel-id>")
		.description("Link an accessible bot to one of your agents")
		.requiredOption("--agent <agent-id>", "Target agent id")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ clawdi channel link <channel-id> --agent <agent-id>")
		.action(async (channelId: string, opts) => {
			const { channelLinkCommand } = await import("../../commands/channel.js");
			await channelLinkCommand(channelId, opts);
		});

	channelCmd
		.command("rotate-token <channel-id>")
		.description("Rotate the agent SDK token for one of your bot-agent links")
		.requiredOption("--link <link-id>", "Bot-agent link id")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExample:\n  $ clawdi channel rotate-token <channel-id> --link <link-id>",
		)
		.action(async (channelId: string, opts) => {
			const { channelRotateTokenCommand } = await import("../../commands/channel.js");
			await channelRotateTokenCommand(channelId, opts);
		});

	channelCmd
		.command("pair-code <channel-id>")
		.description("Create a one-time code to pair an external chat to an agent link")
		.option("--agent <agent-id>", "Create or reuse a link for this agent")
		.option("--link <link-id>", "Use an existing bot-agent link")
		.option("--ttl <seconds>", "Pair code TTL in seconds", parsePositiveInteger, 300)
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExample:\n  $ clawdi channel pair-code <channel-id> --agent <agent-id>\n  $ clawdi channel pair-code <channel-id> --link <link-id>",
		)
		.action(async (channelId: string, opts) => {
			const { channelPairCodeCommand } = await import("../../commands/channel.js");
			await channelPairCodeCommand(channelId, opts);
		});

	channelCmd
		.command("send <channel-id>")
		.description("Queue an outbound message to a paired chat or explicit chat id")
		.option("--binding <binding-id>", "Paired chat binding id")
		.option("--chat <external-chat-id>", "External provider chat id")
		.requiredOption("--text <text>", "Message text")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			'\nExamples:\n  $ clawdi channel send <channel-id> --binding <binding-id> --text "deploy done"\n  $ clawdi channel send <channel-id> --chat <chat-id> --text "hello" --json',
		)
		.action(async (channelId: string, opts) => {
			const { channelSendCommand } = await import("../../commands/channel.js");
			await channelSendCommand(channelId, opts);
		});

	channelCmd
		.command("bindings <channel-id>")
		.description("List your paired external chats for a channel")
		.option("--json", "Output as JSON")
		.action(async (channelId: string, opts: { json?: boolean }) => {
			const { channelBindingsCommand } = await import("../../commands/channel.js");
			await channelBindingsCommand(channelId, opts);
		});

	channelCmd
		.command("sync-commands <channel-id>")
		.description("Sync provider slash commands for one of your private bots")
		.option("--guild <guild-id>", "Discord guild id for guild-scoped command sync")
		.option(
			"--commands <json>",
			"Command spec JSON array; defaults to clawdi_pair and clawdi_unpair",
		)
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExample:\n  $ clawdi channel sync-commands <channel-id>\n  $ clawdi channel sync-commands <channel-id> --guild <discord-guild-id>",
		)
		.action(async (channelId: string, opts) => {
			const { channelSyncCommandsCommand } = await import("../../commands/channel.js");
			await channelSyncCommandsCommand(channelId, opts);
		});

	channelCmd
		.command("delete <channel-id>")
		.description("Archive one of your private channel bots")
		.option("-y, --yes", "Confirm deletion without prompting")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ clawdi channel delete <channel-id> --yes")
		.action(async (channelId: string, opts: { yes?: boolean; json?: boolean }) => {
			const { channelDeleteCommand } = await import("../../commands/channel.js");
			await channelDeleteCommand(channelId, opts);
		});
}
