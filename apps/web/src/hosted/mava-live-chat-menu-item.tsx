"use client";

import { MessagesSquare } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { requestMavaWebChatToggle } from "@/hosted/mava";

export function MavaLiveChatMenuItem() {
	return (
		<DropdownMenuItem data-hosted="true" onClick={() => requestMavaWebChatToggle()}>
			<MessagesSquare />
			Live chat
		</DropdownMenuItem>
	);
}
