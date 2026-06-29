import { createFileRoute } from "@tanstack/react-router";
import SignUpPage from "@/app/(auth)/sign-up/[[...sign-up]]/page";

export const Route = createFileRoute("/sign-up/$")({
	component: SignUpPage,
});
