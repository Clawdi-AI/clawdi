import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import SignUpPage from "@/pages/auth/sign-up";

export const Route = createFileRoute("/sign-up")({
	head: () => routeHeadTitle("Sign up"),
	component: SignUpPage,
});
