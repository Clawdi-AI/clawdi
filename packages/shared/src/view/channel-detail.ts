export const channelDetailCopy = {
	pairDescription: "Use the link or pairing command to connect a chat.",
	pairManually: "Pair manually",
	server: "Server",
	directMessage: "Direct message",
	addToApps: "Add to my apps",
	addToServer: "Add to server",
	openProvider: "Open",
	sendTo: "Send this to",
	sendWhatsApp: "Send this in the WhatsApp chat you want to connect:",
	discordServer:
		"1. Add the bot to the server. You need Manage Server or Administrator. 2. In that server, run the pairing command and paste this into the required code option:",
	discordDm:
		"1. Install the app and choose Add to my apps in Discord. 2. Open the app from Discord Direct Messages. 3. Run the pairing command and paste this into the required code option:",
	unlinkTitle: "Unlink agent?",
	unlinkDescription: "Its paired chats will stop using this channel.",
	unlink: "Unlink agent",
	pairingCommands: "Pairing commands",
	publishCommands: "Publish commands",
	publishing: "Publishing…",
	noCommands: "No pairing commands are available to publish.",
	discordTitle: "Verify Discord credentials",
	discordDescription:
		"Clawdi doesn't verify these credentials with Discord. Send a test message before relying on this channel. To replace them, remove and reconnect it.",
	noLinkedAgents: "No agents linked",
	noLinkedAgentsDescription: "Link an agent here, then pair a chat for it.",
	noActivity: "No activity yet",
	noActivityDescription: "Messages and delivery events will show up here.",
} as const;

export function supportsPairingCommands(provider: string) {
	return provider === "telegram" || provider === "discord";
}
export function pairingCommandsDescription(label: string, supported: boolean) {
	return supported
		? `Publish Clawdi’s pairing commands to ${label}.`
		: `${label} does not support pairing commands.`;
}
export function publishedCommandsLabel(count: number) {
	return `Published ${count} command${count === 1 ? "" : "s"}`;
}

export function pairCodeExpiryLabel(expiresAt: string, nowMs: number): string {
	const expiresAtMs = Date.parse(expiresAt);
	if (!Number.isFinite(expiresAtMs)) return "Expired — generate a new link";
	const remainingSeconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
	if (remainingSeconds <= 0) return "Expired — generate a new link";
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	return `Expires in ${minutes > 0 ? `${minutes}m ` : ""}${seconds}s`;
}
