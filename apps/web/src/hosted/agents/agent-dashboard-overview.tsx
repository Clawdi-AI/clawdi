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
			className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-center sm:justify-between"
		>
			<div className="flex min-w-0 items-center gap-3">
				<AgentIcon agent={runtime} size="lg" />
				<div className="min-w-0 space-y-1">
					<h2 id="agent-dashboard-title" className="text-base font-semibold">
						{label}
					</h2>
					<p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
						<StatusDot
							status={available ? presentation.tone : running ? "warning" : presentation.tone}
						/>
						{available ? "Ready" : running && !degraded ? "Not ready yet" : presentation.label}
					</p>
				</div>
			</div>
			<Button
				render={available ? <Link {...agentSectionLink(agentId, "console")} /> : undefined}
				nativeButton={!available}
				disabled={!available}
				className="shrink-0"
			>
				Open Dashboard
				<ArrowRight />
			</Button>
		</section>
	);
}
