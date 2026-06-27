import type { HostedDeployment } from "@/hosted/billing/contracts";
import { agentSectionHref } from "@/lib/agent-routes";

export function hostedEnvironmentHref(deployment: HostedDeployment): string | null {
	const envId = Object.values(deployment.config_info?.clawdi_cloud_environments ?? {}).find(
		(value): value is string => Boolean(value),
	);
	return envId ? agentSectionHref(envId, "overview", "source=on-clawdi") : null;
}
