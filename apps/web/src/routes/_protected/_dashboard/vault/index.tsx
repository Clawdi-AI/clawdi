import { createFileRoute } from "@tanstack/react-router";
import VaultPage from "@/app/(dashboard)/vault/page";

export const Route = createFileRoute("/_protected/_dashboard/vault/")({
	component: VaultPage,
});
