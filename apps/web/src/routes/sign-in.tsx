import { createFileRoute, redirect } from "@tanstack/react-router";
import { deployChannelAuthSearch } from "@/lib/deploy-channel";
import { routeHeadTitle } from "@/lib/document-title";
import SignInPage from "@/pages/auth/sign-in";

export const Route = createFileRoute("/sign-in")({
	beforeLoad: ({ location }) => {
		const search = deployChannelAuthSearch(location.searchStr);
		if (search) throw redirect({ href: `/sign-in${search}`, replace: true });
	},
	head: () => routeHeadTitle("Sign in"),
	component: SignInPage,
});
