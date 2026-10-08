"use client";

import { useEffect } from "react";
import { AddAgentSetup } from "@/components/dashboard/add-agent-setup";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";
const loadAnalytics = IS_HOSTED_BUILD ? () => import("@/hosted/posthog") : null;

/**
 * The shared "Add an Agent" flow opened from the sidebar and homepage.
 */
export function AddAgentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	useEffect(() => {
		if (!open || !loadAnalytics) return;
		let cancelled = false;
		void loadAnalytics()
			.then((sdk) => {
				if (!cancelled) sdk.trackEvent({ name: "agent_setup_opened", properties: {} });
			})
			.catch(() => {
				/* Analytics must not interrupt onboarding. */
			});
		return () => {
			cancelled = true;
		};
	}, [open]);
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Add an agent</DialogTitle>
					<DialogDescription>
						Connect an agent you run on your machine or server — Claude Code, Codex, Hermes,
						OpenClaw, Pi, or OpenCode.
					</DialogDescription>
				</DialogHeader>
				<AddAgentSetup />
			</DialogContent>
		</Dialog>
	);
}
