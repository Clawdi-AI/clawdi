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
