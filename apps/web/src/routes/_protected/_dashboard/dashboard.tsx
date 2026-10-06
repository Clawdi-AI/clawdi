import { createFileRoute, redirect } from "@tanstack/react-router";

// Parent admission must finish before this authenticated overview alias redirects.
export const Route = createFileRoute("/_protected/_dashboard/dashboard")({
	beforeLoad: ({ location }) => {
		throw redirect({
			href: `/${location.searchStr}${location.hash ? `#${location.hash}` : ""}`,
			replace: true,
			headers: { "Cache-Control": "private, no-store" },
		});
	},
});
