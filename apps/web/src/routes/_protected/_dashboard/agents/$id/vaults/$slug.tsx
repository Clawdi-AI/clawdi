import { createFileRoute } from "@tanstack/react-router";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { agentSectionHref } from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import { agentResourceScope } from "@/lib/resource-navigation";
import VaultDetailPage from "@/pages/dashboard/vault/[slug]/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/vaults/$slug")({
	head: () => routeHeadTitle("Vault"),
	component: AgentVaultDetailRoute,
});

function AgentVaultDetailRoute() {
	const { id, slug } = Route.useParams();
	const search = Route.useSearch();
	return (
		<AgentResourceRouteGate
			agentId={id}
			returnHref={agentSectionHref(id, "vaults", search)}
			returnLabel="Agent Vaults"
		>
			<VaultDetailPage slug={slug} scope={agentResourceScope(id, search)} />
		</AgentResourceRouteGate>
	);
}
