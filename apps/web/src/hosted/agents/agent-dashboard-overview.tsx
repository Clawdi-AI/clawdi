import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { Button } from "@/components/ui/button";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	deploymentRuntimeStatusPresentation,
	hasCurrentRuntimeHealthDegradation,
	isRunningStatus,
} from "@/hosted/deployment-status";
import { runtimeConsoleUrl } from "@/hosted/runtimes";
import { agentSectionLink } from "@/lib/agent-routes";
import { runtimeBrowserUiLabel } from "@/lib/navigation-model";
import { cn } from "@/lib/utils";

export function AgentDashboardOverview({
	agentId,
	deployment,
	className,
}: {
	agentId: string;
	deployment: HostedDeployment;
	className?: string;
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
			className={cn("flex min-w-0 flex-col", className)}
		>
			<Button
				render={available ? <Link {...agentSectionLink(agentId, "console")} /> : undefined}
				nativeButton={!available}
				disabled={!available}
				aria-labelledby="agent-dashboard-title"
				aria-describedby="agent-dashboard-subtitle"
				variant="outline"
				className="h-auto min-h-24 w-full flex-1 justify-start gap-3 border-primary/30 bg-primary/5 px-4 py-4 text-left whitespace-normal hover:bg-primary/10"
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
		</section>
	);
}
