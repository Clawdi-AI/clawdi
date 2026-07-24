"use client";

import { Link } from "@tanstack/react-router";
import { Rocket, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { AddAgentSetup } from "@/components/dashboard/add-agent-setup";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type OnboardingCardProps = {
	variant?: "first-agent" | "additional-agent";
	hosted?: boolean;
};

/**
 * Overview hero card for connecting a new agent. Rendered in the Overview
 * primary slot when the user has zero agents, and as a secondary
 * side-panel card once at least one agent is registered. Hosted first-agent
 * onboarding leads with deploy and reveals the shared CLI setup on demand.
 */
export function OnboardingCard({ variant = "first-agent", hosted = false }: OnboardingCardProps) {
	const [showCliSetup, setShowCliSetup] = useState(false);
	const isAdditionalAgent = variant === "additional-agent";
	const showHostedFirstAgentChoice = hosted && !isAdditionalAgent;
	const title = isAdditionalAgent
		? "Add another agent"
		: showHostedFirstAgentChoice
			? "Get your first agent running"
			: "Let's connect your first agent";
	const description = isAdditionalAgent
		? "Manage multiple agents from one place. Projects help each agent use the right skills and credentials."
		: showHostedFirstAgentChoice
			? "Deploy a fully hosted agent in minutes, or connect an agent you already run with the CLI."
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
				{showHostedFirstAgentChoice ? (
					<>
						<div className="flex flex-col gap-2 sm:flex-row">
							<Button render={<Link to="/deploy" />} nativeButton={false} size="lg">
								<Rocket data-icon="inline-start" /> Deploy a hosted agent
							</Button>
							<Button
								type="button"
								variant="outline"
								size="lg"
								aria-expanded={showCliSetup}
								aria-controls={showCliSetup ? "first-agent-cli-setup" : undefined}
								onClick={() => setShowCliSetup((visible) => !visible)}
							>
								<TerminalSquare data-icon="inline-start" /> Connect via CLI
							</Button>
						</div>
						{showCliSetup ? (
							<div id="first-agent-cli-setup" className="space-y-4 border-t pt-5">
								<div>
									<h3 className="text-sm font-semibold">Connect an agent you already run</h3>
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
