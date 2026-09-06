import { OverviewNavigationCard } from "@/components/dashboard/agent-overview-capabilities";
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
	const item = AGENT_SECTION_NAVIGATION_ITEMS.console;
	return (
		<div data-hosted="true" className="min-w-0">
			<OverviewNavigationCard
				id="dashboard"
				title="Chat on Web"
				className="bg-identity-6-bg/50 dark:bg-identity-6-bg/30"
				description={runtimeBrowserUiLabel(runtime)}
				icon={item.icon}
				tint={item.tint}
				link={available ? agentSectionLink(agentId, "console") : null}
				disabled={!available}
			/>
		</div>
	);
}
