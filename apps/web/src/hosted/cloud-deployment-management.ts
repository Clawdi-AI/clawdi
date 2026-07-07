import type { HostedDeployment } from "@/hosted/billing/contracts";

export type CloudDeploymentManagementGate = {
	canCreateCloudAgents: boolean;
	deployments: readonly Pick<HostedDeployment, "id">[] | null | undefined;
};

export function hasExistingCloudDeployments(
	deployments: readonly Pick<HostedDeployment, "id">[] | null | undefined,
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
