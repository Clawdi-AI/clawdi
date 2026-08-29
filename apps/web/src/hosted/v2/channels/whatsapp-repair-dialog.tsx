"use client";

import { AlertCircle } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { WhatsAppDeviceOnboarding } from "@/hosted/v2/channels/whatsapp-device-onboarding";

export function WhatsAppRepairDialog({
	open,
	accountId,
	channelName,
	onOpenChange,
	onRepaired,
}: {
	open: boolean;
	accountId: string;
	channelName: string;
	onOpenChange: (open: boolean) => void;
	onRepaired: () => void;
}) {
	const [started, setStarted] = useState(false);

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) setStarted(false);
			}}
		>
			<DialogContent
				data-hosted="true"
				data-v2="true"
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
			>
				<DialogHeader>
					<DialogTitle>Repair WhatsApp before linking</DialogTitle>
					<DialogDescription>
						<span className="font-medium text-foreground">{channelName}</span> needs a fresh
						linked-device connection. The Custom bot, existing Agent Links, paired chats, and
						history stay unchanged.
					</DialogDescription>
				</DialogHeader>
				{started ? (
					<WhatsAppDeviceOnboarding repairAccountId={accountId} onDone={onRepaired} />
				) : (
					<>
						<Alert className="border-warning/30 bg-warning-muted">
							<AlertCircle aria-hidden />
							<AlertTitle>Reconnect WhatsApp</AlertTitle>
							<AlertDescription>
								Repair clears only the invalid linked-device login, then asks you to scan a fresh
								QR. It does not replace this Custom bot.
							</AlertDescription>
						</Alert>
						<DialogFooter>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button onClick={() => setStarted(true)}>Repair WhatsApp</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
