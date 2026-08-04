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
	const projectId = typeof search.project === "string" ? search.project : undefined;
	const scope = agentResourceScope(id, search, projectId);
	return (
		<AgentResourceRouteGate
			agentId={id}
			returnHref={agentSectionHref(id, "projects", search)}
			returnLabel="Agent Projects"
		>
			<VaultDetailPage slug={slug} scope={scope} />
		</AgentResourceRouteGate>
	);
}
