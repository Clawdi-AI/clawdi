"use client";

import { CLAWDI_HELP_COPY } from "@clawdi/shared/view";
import { MessagesSquare } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { openChatwoot } from "@/lib/chatwoot";

export function ChatwootLiveChatMenuItem() {
	return (
		<DropdownMenuItem data-hosted="true" onClick={openChatwoot}>
			<MessagesSquare />
			{CLAWDI_HELP_COPY.liveChat}
		</DropdownMenuItem>
	);
}
