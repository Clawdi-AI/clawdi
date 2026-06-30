import type { HostedDeployment } from "@/hosted/billing/contracts";
import { deploymentRuntimes, runtimeEnvironmentId } from "@/hosted/runtimes";
import { agentSectionHref } from "@/lib/agent-routes";

export function hostedEnvironmentHref(deployment: HostedDeployment): string | null {
	const envId = deploymentRuntimes(deployment)
		.map((runtime) => runtimeEnvironmentId(deployment.config_info, runtime))
		.find((value): value is string => Boolean(value));
	return envId ? agentSectionHref(envId, "overview", "source=on-clawdi") : null;
}
