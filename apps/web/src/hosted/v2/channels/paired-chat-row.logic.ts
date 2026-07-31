type PairedChatIdentity = {
	external_chat_id: string;
	external_chat_name: string | null;
	external_chat_type: string | null;
};

export function pairedChatTitle(binding: PairedChatIdentity): string {
	const name = binding.external_chat_name?.trim();
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
