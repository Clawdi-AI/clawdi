import type { HostedDeployment } from "@/hosted/billing/contracts";
import { runtimeEnvironmentId } from "@/hosted/runtimes";
import { AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY, agentSectionHref } from "@/lib/agent-routes";

export function hostedEnvironmentHref(deployment: HostedDeployment): string {
	return agentSectionHref(runtimeEnvironmentId(deployment), "overview", {
		source: "on-clawdi",
		[AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY]: deployment.resource.id,
	});
}
