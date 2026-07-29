import type { QueryClient } from "@tanstack/react-query";
import { invalidateDeploymentSnapshots } from "@/hosted/agents/deployment-hooks";
import { agentSectionHref } from "@/lib/agent-routes";

export type AcceptedDeploymentNavigate = (options: { href: string; replace: boolean }) => void;

/** Refresh committed deployment membership and immediately open its canonical route. */
export function navigateToAcceptedDeployment({
	deploymentId,
	navigate,
	queryClient,
	replace = false,
}: {
	deploymentId: string;
	navigate: AcceptedDeploymentNavigate;
	queryClient: QueryClient;
	replace?: boolean;
}): void {
	invalidateDeploymentSnapshots(queryClient);
	navigate({ href: agentSectionHref(deploymentId, "overview", "source=on-clawdi"), replace });
}
