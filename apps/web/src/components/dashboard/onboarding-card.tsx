"use client";

import { onboardingCardClasses } from "@clawdi/shared/ui";

import { onboardingCardModel } from "@clawdi/shared/view";

import { Link } from "@tanstack/react-router";
import { Rocket, TerminalSquare } from "lucide-react";
import { useConnectAgent } from "@/components/dashboard/use-connect-agent";
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
 * choice. Every connect action goes through `useConnectAgent`, like the sidebar.
 */
export function OnboardingCard({
	variant = "first-agent",
	canDeployOnClawdi = false,
}: OnboardingCardProps) {
	const { connect, dialog } = useConnectAgent();
	const { isAdditionalAgent, title, description } = onboardingCardModel(variant, canDeployOnClawdi);

	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle className={onboardingCardClasses.title}>
						<Rocket className={onboardingCardClasses.titleIcon} />
						{title}
					</CardTitle>
					<CardDescription>{description}</CardDescription>
				</CardHeader>
				<CardContent>
					<div
						className={
							canDeployOnClawdi && !isAdditionalAgent
								? onboardingCardClasses.actionsWithDeploy
								: onboardingCardClasses.actions
						}
					>
						{canDeployOnClawdi ? (
							<Button
								render={<Link to="/deploy" />}
								nativeButton={false}
								size="lg"
								className={onboardingCardClasses.deployAction}
							>
								<Rocket data-icon="inline-start" /> Deploy a Cloud Agent
							</Button>
						) : null}
						<Button
							type="button"
							variant={canDeployOnClawdi ? "outline" : "default"}
							size="lg"
							className={onboardingCardClasses.connectAction}
							onClick={connect}
						>
							<TerminalSquare data-icon="inline-start" /> Connect your own agent
						</Button>
					</div>
				</CardContent>
			</Card>
			{dialog}
		</>
	);
}
