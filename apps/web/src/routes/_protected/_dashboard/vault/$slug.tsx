import { createFileRoute } from "@tanstack/react-router";
import VaultDetailPage from "@/app/(dashboard)/vault/[slug]/page";

export const Route = createFileRoute("/_protected/_dashboard/vault/$slug")({
	component: VaultDetailPage,
});
