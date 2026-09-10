import { createFileRoute } from "@tanstack/react-router";
import { VaultRequestPage } from "@/pages/vault-request";

export const Route = createFileRoute("/vault-request")({
	head: () => ({
		meta: [
			{ title: "Supply Vault secrets · Clawdi" },
			{ name: "referrer", content: "no-referrer" },
		],
	}),
	headers: () => ({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }),
	component: VaultRequestPage,
});
