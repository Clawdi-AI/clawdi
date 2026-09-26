"use client";

import { MessagesSquare } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { openChatwoot } from "@/lib/chatwoot";

export function ChatwootLiveChatMenuItem() {
	return (
		<DropdownMenuItem data-hosted="true" onClick={openChatwoot}>
			<MessagesSquare />
			Live chat
		</DropdownMenuItem>
	);
}
