import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import VaultDetailPage from "@/pages/dashboard/vault/[slug]/page";

export const Route = createFileRoute("/_protected/_dashboard/vault/$slug")({
	head: () => routeHeadTitle("Vault"),
	component: VaultDetailRoute,
});

function VaultDetailRoute() {
	const { slug } = Route.useParams();
	return <VaultDetailPage slug={slug} />;
}
