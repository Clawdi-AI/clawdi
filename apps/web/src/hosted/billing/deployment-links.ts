import type { HostedDeployment } from "@/hosted/billing/contracts";

export function hostedEnvironmentHref(deployment: HostedDeployment): string | null {
	const envId = Object.values(deployment.config_info?.clawdi_cloud_environments ?? {}).find(
		(value): value is string => Boolean(value),
	);
	return envId ? `/agents/${encodeURIComponent(envId)}?source=on-clawdi` : null;
}
