import { OverviewNavigationCard } from "@/components/dashboard/agent-overview-capabilities";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { deploymentRuntimeUiIsReady } from "@/hosted/deployment-status";
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
	const available = deploymentRuntimeUiIsReady(deployment);
	const item = AGENT_SECTION_NAVIGATION_ITEMS.console;
	return (
		<div data-hosted="true" className="min-w-0">
			<OverviewNavigationCard
				id="dashboard"
				title="Chat on the web"
				description={runtimeBrowserUiLabel(runtime)}
				icon={item.icon}
				tint={item.tint}
				link={available ? agentSectionLink(agentId, "console") : null}
				disabled={!available}
			/>
		</div>
	);
}
