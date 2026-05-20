import { Rocket } from "lucide-react";
import { AddAgentSetup } from "@/components/dashboard/add-agent-setup";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type OnboardingCardProps = {
	variant?: "first-agent" | "additional-agent";
};

/**
 * Overview hero card for connecting a new agent. Rendered in the Overview
 * primary slot when the user has zero agents, and as a secondary
 * side-panel card once at least one agent is registered. Shares its
 * Tabs + steps body with the sidebar Quick Create affordance — see
 * `AddAgentSetup`.
 */
export function OnboardingCard({ variant = "first-agent" }: OnboardingCardProps) {
	const isAdditionalAgent = variant === "additional-agent";
	const title = isAdditionalAgent ? "Add another agent" : "Let's connect your first agent";
	const description = isAdditionalAgent
		? "Manage multiple agents from one place. Projects help each agent use the right skills and credentials."
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
			<CardContent>
				<AddAgentSetup />
			</CardContent>
		</Card>
	);
}
