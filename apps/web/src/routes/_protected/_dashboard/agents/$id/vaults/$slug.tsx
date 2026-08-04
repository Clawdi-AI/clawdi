import { createFileRoute } from "@tanstack/react-router";
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
	return <VaultDetailPage slug={slug} scope={agentResourceScope(id, search)} />;
}
