"use client";

import { Link } from "@tanstack/react-router";
import { Rocket, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { AddAgentSetup } from "@/components/dashboard/add-agent-setup";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type OnboardingCardProps = {
	variant?: "first-agent" | "additional-agent";
	canDeployOnClawdi?: boolean;
};

/**
 * Overview hero card for connecting a new agent. Rendered in the Overview
 * primary slot when the user has zero agents, and as a secondary
 * side-panel card once at least one agent is registered. When Cloud agent
 * creation is available, both placements offer the same deploy-or-connect
 * choice and reveal the shared CLI setup on demand.
 */
export function OnboardingCard({
	variant = "first-agent",
	canDeployOnClawdi = false,
}: OnboardingCardProps) {
	const [showCliSetup, setShowCliSetup] = useState(false);
	const isAdditionalAgent = variant === "additional-agent";
	const title = isAdditionalAgent
		? "Add another agent"
		: canDeployOnClawdi
			? "Get your first agent running"
			: "Let's connect your first agent";
	const description = isAdditionalAgent
		? canDeployOnClawdi
			? "Deploy another agent on Clawdi, or connect an agent on your machine."
			: "Connect another agent on your machine and manage it from this dashboard."
		: canDeployOnClawdi
			? "Deploy on Clawdi in minutes, or connect an agent on your machine."
			: "Connect an agent first. Then create a Project to organize reusable skills and credentials you can share with teammates.";

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Rocket className="size-5 text-primary" />
					{title}
				</CardTitle>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				{canDeployOnClawdi ? (
					<>
						<div className="flex flex-col gap-2">
							<Button render={<Link to="/deploy" />} nativeButton={false} size="lg">
								<Rocket data-icon="inline-start" /> Deploy on Clawdi
							</Button>
							<Button
								type="button"
								variant="outline"
								size="lg"
								aria-expanded={showCliSetup}
								aria-controls={showCliSetup ? "first-agent-cli-setup" : undefined}
								onClick={() => setShowCliSetup((visible) => !visible)}
							>
								<TerminalSquare data-icon="inline-start" /> Connect an agent on your machine
							</Button>
						</div>
						{showCliSetup ? (
							<div id="first-agent-cli-setup" className="space-y-4 border-t pt-5">
								<div>
									<h3 className="text-sm font-semibold">Connect an agent on your machine</h3>
									<p className="text-sm text-muted-foreground">
										Run the setup command on the machine where your agent lives.
									</p>
								</div>
								<AddAgentSetup />
							</div>
						) : null}
					</>
				) : (
					<AddAgentSetup />
				)}
			</CardContent>
		</Card>
	);
}
