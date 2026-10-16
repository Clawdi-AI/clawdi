type PairedChatIdentity = {
	external_chat_id: string;
	external_chat_name: string | null;
	external_chat_type: string | null;
};

const DISCORD_DM_TYPES = new Set(["dm", "direct_messages", "group_dm", "private"]);

export function pairedChatScopeLabel(
	provider: string,
	binding: PairedChatIdentity,
): "server" | "direct message" | "chat" {
	if (provider !== "discord") return "chat";
	return DISCORD_DM_TYPES.has(binding.external_chat_type?.toLowerCase() ?? "")
		? "direct message"
		: "server";
}

export function pairedChatTitle(binding: PairedChatIdentity, provider = ""): string {
	const name = binding.external_chat_name?.trim();
	if (provider === "discord") {
		const scope = pairedChatScopeLabel(provider, binding);
		const label = scope === "server" ? "Server" : "Direct message";
		return `${label} · ${name || binding.external_chat_id}`;
	}
	if (name) return name;

	const chatType = binding.external_chat_type?.toLowerCase();
	const typeLabel =
		chatType === "private"
			? "Private chat"
			: chatType === "group" || chatType === "supergroup"
				? "Group chat"
				: "Chat";
	return `${typeLabel} · ${binding.external_chat_id}`;
}

/** Row label for a paired chat: Server / Direct message on Discord, otherwise its chat kind. */
export function pairedChatKindLabel(provider: string, binding: PairedChatIdentity): string {
	const chatType = binding.external_chat_type?.toLowerCase();
	if (provider === "discord")
		return pairedChatScopeLabel(provider, binding) === "direct message"
			? "Direct message"
			: "Server";
	return chatType === "private"
		? "Private chat"
		: chatType === "group" || chatType === "supergroup"
			? "Group chat"
			: "Chat";
}

export const pairedChatsCopy = {
	title: "Paired chats",
	empty: "No paired chats yet.",
	unpair: "Unpair",
	unpairing: "Unpairing…",
	unpairConfirm: "Unpair chat",
	unpairDescription: "Only this chat will be unpaired; other chats and this channel remain active.",
	unpairFailedInline: "Couldn't unpair · Try again",
	unpaired: "Chat unpaired",
	unpairFailed: "Couldn't unpair chat",
	retry: "Retry",
	retrying: "Retrying…",
} as const;

export function pairedChatsDescription(count: number) {
	return `${count} ${count === 1 ? "chat is" : "chats are"} paired through this channel. Unpairing affects only the selected chat.`;
}
export function pairedChatsLoadFailed(provider: string) {
	return provider === "discord"
		? "Couldn’t load paired servers or direct messages"
		: "Couldn’t load paired chats";
}
export function unpairChatTitle(chatName: string) {
	return `Unpair ${chatName}?`;
}
