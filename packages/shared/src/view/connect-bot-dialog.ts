export const connectBotDialogCopy = {
	title: "Add channel",
	unsupported: "Need a provider that Clawdi Channels doesn't support? ",
	unsupportedInventory:
		"Open the relevant agent's OpenClaw Control UI or Hermes Dashboard to configure it.",
	telegramSetupPrefix: "Need a bot token? ",
	discordSetupPrefix: "Need app credentials? ",
	description: "Add a custom bot you manage to your inventory.",
	chooseProvider: "Choose provider",
	name: "Name",
	namePlaceholder: "Support Bot",
	token: "Bot token",
	applicationId: "Application ID",
	publicKey: "Public key",
	publicKeyPlaceholder: "64-character hex public key",
	add: "Add custom bot",
	telegramSetup: "Create a bot with @BotFather",
	discordSetup: "Open Discord Developer Portal",
} as const;

export const channelFormCopy = {
	linkTitle: "Link agent",
	linkDescription: "Choose an agent, then pair one of its chats without leaving this channel.",
	agent: "Agent",
	chooseAgent: "Choose an agent…",
	whatsappTitle: "Connect WhatsApp",
	repairTitle: "Repair WhatsApp before linking",
};

export const channelRemovalCopy = {
	description:
		"This deletes the custom bot, its agent links, and its paired chats. This can't be undone.",
	whatsappDescription:
		"This logs out Clawdi as a linked device and removes the custom bot. Linked agents will stop sending and receiving.",
	remove: "Delete custom bot",
	disconnect: "Disconnect and remove",
};
export function channelRemovalTitle(name: string, whatsapp: boolean) {
	return `${whatsapp ? "Disconnect" : "Delete"} ${name}?`;
}
