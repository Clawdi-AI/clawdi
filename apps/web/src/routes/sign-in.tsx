import { createFileRoute } from "@tanstack/react-router";
import SignInPage from "@/pages/auth/sign-in";

export const Route = createFileRoute("/sign-in")({
	component: SignInPage,
});
