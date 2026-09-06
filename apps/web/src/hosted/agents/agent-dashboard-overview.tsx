import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-badge";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	deploymentRuntimeStatusPresentation,
	hasCurrentRuntimeHealthDegradation,
	isRunningStatus,
} from "@/hosted/deployment-status";
import { runtimeConsoleUrl } from "@/hosted/runtimes";
import { agentSectionLink } from "@/lib/agent-routes";
import { runtimeBrowserUiLabel } from "@/lib/navigation-model";

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
	return (
		<section
			data-hosted="true"
			data-overview-module="dashboard"
			aria-labelledby="agent-dashboard-title"
			className="flex min-w-0 flex-col gap-2"
		>
			<Button
				render={available ? <Link {...agentSectionLink(agentId, "console")} /> : undefined}
				nativeButton={!available}
				disabled={!available}
				aria-labelledby="agent-dashboard-title"
				aria-describedby="agent-dashboard-subtitle agent-dashboard-status"
				variant="outline"
				className="h-auto min-h-24 w-full justify-start gap-3 border-primary/30 bg-primary/5 px-4 py-4 text-left whitespace-normal hover:bg-primary/10"
			>
				<AgentIcon agent={runtime} size="lg" />
				<span className="min-w-0 flex-1 space-y-1">
					<span id="agent-dashboard-title" className="block text-base font-semibold">
						Start Chat
					</span>
					<span
						id="agent-dashboard-subtitle"
						className="block text-sm font-normal text-muted-foreground"
					>
						Open {label}
					</span>
				</span>
				<ArrowRight />
			</Button>
			<p
				id="agent-dashboard-status"
				className="flex items-center gap-2 text-xs text-muted-foreground"
				role="status"
			>
				<StatusDot status={running && !available ? "warning" : presentation.tone} />
				{available ? "Ready" : running && !degraded ? "Not ready yet" : presentation.label}
			</p>
		</section>
	);
}
