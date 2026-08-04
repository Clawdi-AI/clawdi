import { createFileRoute, redirect } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import {
	legacyAgentResourceScope,
	validateResourceDetailSearch,
	vaultDetailLink,
} from "@/lib/resource-navigation";
import VaultDetailPage from "@/pages/dashboard/vault/[slug]/page";

export const Route = createFileRoute("/_protected/_dashboard/vaults/$slug")({
	validateSearch: validateResourceDetailSearch,
	beforeLoad: ({ params, search }) => {
		const legacyScope = legacyAgentResourceScope(search, "vaults");
		if (legacyScope) {
			throw redirect({
				...vaultDetailLink(legacyScope, params.slug, search.vault),
				replace: true,
			});
		}
	},
	head: () => routeHeadTitle("Vault"),
	component: VaultDetailRoute,
});

function VaultDetailRoute() {
	const { slug } = Route.useParams();
	return <VaultDetailPage slug={slug} scope={{ kind: "library" }} />;
}
