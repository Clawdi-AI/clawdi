import { createFileRoute, redirect } from "@tanstack/react-router";
import { deployChannelAuthSearch } from "@/lib/deploy-channel";
import { routeHeadTitle } from "@/lib/document-title";
import SignUpPage from "@/pages/auth/sign-up";

export const Route = createFileRoute("/sign-up")({
	beforeLoad: ({ location }) => {
		const search = deployChannelAuthSearch(location.searchStr);
		if (search) throw redirect({ href: `/sign-up${search}`, replace: true });
	},
	head: () => routeHeadTitle("Sign up"),
	component: SignUpPage,
});
