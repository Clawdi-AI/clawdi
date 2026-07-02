import { hostedRuntimeTargetRouteId } from "@/hosted/agent-identity";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { enabledDeploymentRuntimeTargets } from "@/hosted/runtimes";
import { agentSectionHref } from "@/lib/agent-routes";

export function hostedEnvironmentHref(deployment: HostedDeployment): string | null {
	const target = enabledDeploymentRuntimeTargets(deployment)[0];
	if (!target) return null;
	return agentSectionHref(
		target.environmentId ?? hostedRuntimeTargetRouteId(deployment.id, target.id),
		"overview",
		"source=on-clawdi",
	);
}
