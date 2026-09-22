"use client";

import { MessagesSquare } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { requestChatwootToggle } from "@/lib/chatwoot";

export function ChatwootLiveChatMenuItem() {
	return (
		<DropdownMenuItem data-hosted="true" onClick={requestChatwootToggle}>
			<MessagesSquare />
			Live chat
		</DropdownMenuItem>
	);
}
