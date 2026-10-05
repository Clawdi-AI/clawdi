export const connectBotDialogCopy = {
	title: "Add channel",
	description: "Add a Custom bot you manage to your inventory.",
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
	linkTitle: "Link Agent",
	linkDescription: "Choose an Agent, then pair one of its chats without leaving this channel.",
	agent: "Agent",
	chooseAgent: "Choose an Agent…",
	whatsappTitle: "Connect WhatsApp",
	repairTitle: "Repair WhatsApp before linking",
};

export const channelRemovalCopy = {
	description:
		"This deletes the Custom bot, its Agent links, and its paired chats. This can't be undone.",
	whatsappDescription:
		"This logs out Clawdi as a linked device and removes the Custom bot. Linked Agents will stop sending and receiving.",
	remove: "Delete custom bot",
	disconnect: "Disconnect and remove",
};
export function channelRemovalTitle(name: string, whatsapp: boolean) {
	return `${whatsapp ? "Disconnect" : "Delete"} ${name}?`;
}
