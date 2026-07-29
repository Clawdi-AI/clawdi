"use client";

import { AddAgentSetup } from "@/components/dashboard/add-agent-setup";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/**
 * The shared "Add an agent" flow opened from the sidebar and homepage.
 */
export function AddAgentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Add agent</DialogTitle>
					<DialogDescription>
						Connect an agent on your machine — Claude Code, Codex, Hermes, or OpenClaw.
					</DialogDescription>
				</DialogHeader>
				<AddAgentSetup />
			</DialogContent>
		</Dialog>
	);
}
