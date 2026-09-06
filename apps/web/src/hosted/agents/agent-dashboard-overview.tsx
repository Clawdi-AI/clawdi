import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { OverviewNavigationCard } from "@/components/dashboard/agent-overview-capabilities";
import { Button } from "@/components/ui/button";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	deploymentRuntimeStatusPresentation,
	hasCurrentRuntimeHealthDegradation,
	isRunningStatus,
} from "@/hosted/deployment-status";
import { runtimeConsoleUrl } from "@/hosted/runtimes";
import { agentSectionLink } from "@/lib/agent-routes";
import { AGENT_SECTION_NAVIGATION_ITEMS, runtimeBrowserUiLabel } from "@/lib/navigation-model";

export function AgentDashboardOverview({
	agentId,
	deployment,
}: {
	agentId: string;
	deployment: HostedDeployment;
}) {
	const runtime = deployment.resource.spec.runtime;
	const presentation = deploymentRuntimeStatusPresentation(deployment.resource.status);
	const running = isRunningStatus(presentation.status);
	const degraded = deployment.resource.status
		? hasCurrentRuntimeHealthDegradation(deployment.resource.status)
		: false;
	const available = running && !degraded && Boolean(runtimeConsoleUrl(deployment));
	const label = runtimeBrowserUiLabel(runtime);
	const channels = AGENT_SECTION_NAVIGATION_ITEMS.channels;
	return (
		<section
			data-hosted="true"
			data-overview-section="start-chat"
			aria-labelledby="agent-start-chat-title"
			className="min-w-0 space-y-3"
		>
			<h2 id="agent-start-chat-title" className="text-sm font-semibold">
				Start Chat
			</h2>
			<div className="grid auto-rows-fr gap-3 @2xl/main:grid-cols-2">
				<div data-overview-module="dashboard" className="flex min-w-0 flex-col">
					<Button
						render={available ? <Link {...agentSectionLink(agentId, "console")} /> : undefined}
						nativeButton={!available}
						disabled={!available}
						aria-labelledby="agent-dashboard-title"
						aria-describedby="agent-dashboard-subtitle"
						variant="outline"
						className="h-auto min-h-24 w-full flex-1 justify-start gap-3 rounded-xl border-primary/30 bg-primary/5 px-4 py-4 text-left whitespace-normal hover:bg-primary/10"
					>
						<AgentIcon agent={runtime} size="lg" />
						<span className="min-w-0 flex-1 space-y-1">
							<span id="agent-dashboard-title" className="block text-base font-semibold">
								Web Chat
							</span>
							<span
								id="agent-dashboard-subtitle"
								className="block text-sm font-normal text-muted-foreground"
							>
								{label}
							</span>
						</span>
						<ArrowRight />
					</Button>
				</div>
				<OverviewNavigationCard
					id="channels"
					title="Connect Channel"
					description="Telegram, Discord, or WhatsApp"
					icon={channels.icon}
					tint={channels.tint}
					link={agentSectionLink(agentId, "channels")}
				/>
			</div>
		</section>
	);
}
