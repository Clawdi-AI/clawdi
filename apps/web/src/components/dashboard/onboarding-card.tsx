import { Rocket } from "lucide-react";
import { AddAgentSetup } from "@/components/dashboard/add-agent-setup";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Overview hero card for connecting a new agent. Rendered in the Overview
 * primary slot when the user has zero agents, and as a secondary
 * side-panel card once at least one agent is registered. Shares its
 * Tabs + steps body with the sidebar Quick Create affordance — see
 * `AddAgentSetup`.
 */
export function OnboardingCard() {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Rocket className="size-5 text-primary" />
					Add an agent
				</CardTitle>
				<CardDescription>
					Connect another machine or agent type — works for Claude Code, Codex, Hermes and OpenClaw.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<AddAgentSetup />
			</CardContent>
		</Card>
	);
}
