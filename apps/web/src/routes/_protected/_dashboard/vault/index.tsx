import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import VaultPage from "@/pages/dashboard/vault/page";

export const Route = createFileRoute("/_protected/_dashboard/vault/")({
	head: () => routeHeadTitle("Vaults"),
	component: VaultPage,
});
