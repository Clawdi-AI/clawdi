import type { HostedDeployment } from "@/hosted/billing/contracts";

export function usesActiveFreeComputeSlot(deployments: HostedDeployment[] | undefined): boolean {
	return (deployments ?? []).some(
		(deployment) =>
			deployment.config_info?.compute_plan_slug === "compute_free" &&
			deployment.status !== "stopped",
	);
}
