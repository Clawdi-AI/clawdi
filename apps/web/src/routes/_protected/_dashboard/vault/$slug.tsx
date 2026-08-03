import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/_dashboard/vault/$slug")({
	beforeLoad: ({ params, search }) => {
		throw redirect({
			to: "/vaults/$slug",
			params: { slug: params.slug },
			search,
			replace: true,
		});
	},
});
