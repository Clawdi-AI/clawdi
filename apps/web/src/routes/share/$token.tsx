import { createFileRoute } from "@tanstack/react-router";
import ShareProjectPage from "@/app/share/[token]/page";

export const Route = createFileRoute("/share/$token")({
	component: ShareProjectPage,
});
