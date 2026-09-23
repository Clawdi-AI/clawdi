"use client";

import { MessagesSquare } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { openChatwoot, useChatwootOptIn } from "@/lib/chatwoot";

export function ChatwootLiveChatMenuItem() {
	if (!useChatwootOptIn()) return null;
	return (
		<DropdownMenuItem data-hosted="true" onClick={openChatwoot}>
			<MessagesSquare />
			Live chat
		</DropdownMenuItem>
	);
}
