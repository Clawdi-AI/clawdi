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
 * Modal variant of the "Add an agent" flow. Opened from the sidebar's
 * Quick Create button. Same Tabs body as the Overview `OnboardingCard`
 * so users see one consistent UI for connecting a new agent.
 */
export function AddAgentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Add an agent</DialogTitle>
					<DialogDescription>
						Connect another machine or agent — Claude Code, Codex, Hermes, or OpenClaw.
					</DialogDescription>
				</DialogHeader>
				<AddAgentSetup />
			</DialogContent>
		</Dialog>
	);
}
