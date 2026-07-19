import type { HostedDeployment } from "@/hosted/billing/contracts";

export type CloudDeploymentManagementGate = {
	canCreateCloudAgents: boolean;
	deployments: readonly HostedDeployment[] | null | undefined;
};

export function hasExistingCloudDeployments(
	deployments: readonly HostedDeployment[] | null | undefined,
): boolean {
	return (deployments?.length ?? 0) > 0;
}

export function cloudDeploymentManagementGate({
	canCreateCloudAgents,
	deployments,
}: CloudDeploymentManagementGate): {
	showExistingManagement: boolean;
	showNewDeploymentSurfaces: boolean;
} {
	return {
		showExistingManagement: hasExistingCloudDeployments(deployments),
		showNewDeploymentSurfaces: canCreateCloudAgents,
	};
}
