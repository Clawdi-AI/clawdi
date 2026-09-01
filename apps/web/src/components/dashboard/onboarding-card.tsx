"use client";

import { Link } from "@tanstack/react-router";
import { Rocket, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { AddAgentDialog } from "@/components/dashboard/add-agent-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDesktopBridge } from "@/lib/desktop";

type OnboardingCardProps = {
	variant?: "first-agent" | "additional-agent";
	canDeployOnClawdi?: boolean;
};

/**
 * Overview hero card for connecting a new agent. Rendered in the Overview
 * primary slot when the user has zero agents, and as a secondary
 * side-panel card once at least one agent is registered. When Cloud agent
 * creation is available, both placements offer the same deploy-or-connect
 * choice. Every connect action opens the same dialog used by the sidebar.
 */
export function OnboardingCard({
	variant = "first-agent",
	canDeployOnClawdi = false,
}: OnboardingCardProps) {
	const desktopBridge = useDesktopBridge();
	const [connectOpen, setConnectOpen] = useState(false);
	const isAdditionalAgent = variant === "additional-agent";
	const title = isAdditionalAgent
		? "Add another Agent"
		: canDeployOnClawdi
			? "Get your first Agent running"
			: "Let's connect your first Agent";
	const description = isAdditionalAgent
		? canDeployOnClawdi
			? "Deploy another Agent on Clawdi, or connect one from your machine."
			: "Connect another Agent on your machine and manage it from this dashboard."
		: canDeployOnClawdi
			? "Deploy an Agent on Clawdi, or connect one from your machine."
			: "Connect an Agent on your machine and manage it from this dashboard.";
	const connectAgent = () => {
		if (desktopBridge) {
			void desktopBridge.openConnectWizard().catch(() => setConnectOpen(true));
			return;
		}
		setConnectOpen(true);
	};

	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Rocket className="size-5 text-primary" />
						{title}
					</CardTitle>
					<CardDescription>{description}</CardDescription>
				</CardHeader>
				<CardContent>
					<div
						className={
							canDeployOnClawdi && !isAdditionalAgent ? "grid gap-2 xl:grid-cols-2" : "grid gap-2"
						}
					>
						{canDeployOnClawdi ? (
							<Button
								render={<Link to="/deploy" />}
								nativeButton={false}
								size="lg"
								className="w-full"
							>
								<Rocket data-icon="inline-start" /> Deploy on Clawdi
							</Button>
						) : null}
						<Button
							type="button"
							variant={canDeployOnClawdi ? "outline" : "default"}
							size="lg"
							className="h-auto min-h-10 w-full whitespace-normal py-2"
							onClick={connectAgent}
						>
							<TerminalSquare data-icon="inline-start" /> Connect an Agent on your machine
						</Button>
					</div>
				</CardContent>
			</Card>
			<AddAgentDialog open={connectOpen} onClose={() => setConnectOpen(false)} />
		</>
	);
}
