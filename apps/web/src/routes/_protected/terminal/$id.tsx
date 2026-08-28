import { createFileRoute, notFound } from "@tanstack/react-router";
import { isAgentRouteId } from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import { AgentDetailClient } from "@/pages/dashboard/agents/agent-detail-client";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

export const Route = createFileRoute("/_protected/terminal/$id")({
	beforeLoad: ({ params }) => {
		if (!IS_HOSTED_BUILD || !isAgentRouteId(params.id)) throw notFound();
	},
	head: () => routeHeadTitle("Terminal"),
	component: TerminalWindowRoute,
});

function TerminalWindowRoute() {
	const { id } = Route.useParams();
	return (
		<main
			data-mava-launcher="hidden"
			className="flex h-svh min-h-0 w-full overflow-hidden bg-background"
		>
			<AgentDetailClient environmentId={id} section="terminal" routeSearch={{}} standalone />
		</main>
	);
}
