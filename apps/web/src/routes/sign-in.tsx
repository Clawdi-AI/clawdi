import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import SignInPage from "@/pages/auth/sign-in";

export const Route = createFileRoute("/sign-in")({
	head: () => routeHeadTitle("Sign in"),
	component: SignInPage,
});
