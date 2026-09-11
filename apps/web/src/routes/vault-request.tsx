import { createFileRoute } from "@tanstack/react-router";
import { VaultRequestPage } from "@/pages/vault-request";

export const Route = createFileRoute("/vault-request")({
	head: () => ({
		meta: [{ title: "Save to Vault · Clawdi" }, { name: "referrer", content: "no-referrer" }],
	}),
	headers: () => ({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }),
	component: VaultRequestPage,
});
