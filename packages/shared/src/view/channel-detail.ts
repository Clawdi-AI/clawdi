export const channelDetailCopy = {
	pairingCommands: "Pairing commands",
	publishCommands: "Publish commands",
	publishing: "Publishing…",
	noCommands: "No pairing commands are available to publish.",
	discordTitle: "Verify Discord credentials",
	discordDescription:
		"Clawdi stores Discord credentials during setup but does not verify them with Discord. Send a test message and confirm its activity and status before relying on this channel. To replace credentials, remove the channel and reconnect it.",
	noLinkedAgents: "No Agents linked",
	noLinkedAgentsDescription: "Link an Agent here, then pair a chat for it.",
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
