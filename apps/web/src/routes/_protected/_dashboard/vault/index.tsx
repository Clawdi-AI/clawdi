import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/_dashboard/vault/")({
	beforeLoad: ({ search }) => {
		throw redirect({ to: "/vaults", search, replace: true });
	},
});
