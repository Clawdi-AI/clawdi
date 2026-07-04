import type { HostedDeployment } from "@/hosted/billing/contracts";
import { parseDeploymentStatus } from "@/hosted/deployment-status";

export function usesActiveFreeComputeSlot(deployments: HostedDeployment[] | undefined): boolean {
	return (deployments ?? []).some((deployment) => {
		if (deployment.config_info?.compute_plan_slug !== "compute_free") return false;
		const status = parseDeploymentStatus(deployment.status);
		return status.kind !== "stopped" && status.kind !== "deleted";
	});
}
