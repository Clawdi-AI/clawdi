import type { QueryClient } from "@tanstack/react-query";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import { agentSectionHref } from "@/lib/agent-routes";

export type AcceptedDeploymentNavigate = (options: {
	href: string;
	replace: boolean;
}) => void | Promise<void>;

type AcceptedDeploymentRequestResolver = (
	deployRequestId: string,
) => Promise<{ deploymentId: string }>;

function upsertAuthoritativeDeployment(
	deployments: readonly HostedDeployment[] | undefined,
	authoritative: HostedDeployment,
): HostedDeployment[] {
	if (!deployments) return [authoritative];
	const deploymentId = authoritative.resource.id;
	const existingIndex = deployments.findIndex(
		(deployment) => deployment.resource.id === deploymentId,
	);
	if (existingIndex === -1) return [...deployments, authoritative];
	return deployments.map((deployment, index) =>
		index === existingIndex ? authoritative : deployment,
	);
}

/** Hydrate committed deployment authority before opening its canonical route. */
export async function navigateToAcceptedDeployment({
	deploymentId,
	getDeployment,
	navigate,
	queryClient,
	replace = false,
}: {
	deploymentId: string;
	getDeployment: (deploymentId: string) => Promise<HostedDeployment>;
	navigate: AcceptedDeploymentNavigate;
	queryClient: QueryClient;
	replace?: boolean;
}): Promise<void> {
	const authoritative = await getDeployment(deploymentId);
	if (authoritative.resource.id !== deploymentId) {
		throw new Error("The deployment service returned a different deployment.");
	}

	// A list read that started before acceptance can be older than the committed
	// by-id row. Cancel it before the upsert so it cannot erase this handoff.
	await queryClient.cancelQueries({ queryKey: billingKeys.deployments, exact: true });
	queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, (deployments) =>
		upsertAuthoritativeDeployment(deployments, authoritative),
	);
	void queryClient.invalidateQueries({ queryKey: ["get", "/v1/agents"] });

	await navigate({
		href: agentSectionHref(deploymentId),
		replace,
	});
}

/** Resolve the durable checkout lineage, then reuse the canonical deployment handoff. */
export async function navigateToAcceptedDeploymentRequest({
	deployRequestId,
	onAccepted,
	resolveDeploymentRequest,
	...navigation
}: Omit<Parameters<typeof navigateToAcceptedDeployment>[0], "deploymentId"> & {
	deployRequestId: string;
	onAccepted?: () => void;
	resolveDeploymentRequest: AcceptedDeploymentRequestResolver;
}): Promise<void> {
	const { deploymentId } = await resolveDeploymentRequest(deployRequestId);
	onAccepted?.();
	await navigateToAcceptedDeployment({ ...navigation, deploymentId });
}
