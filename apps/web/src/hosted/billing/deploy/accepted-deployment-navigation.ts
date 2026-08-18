import type { QueryClient } from "@tanstack/react-query";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import { agentRouteIdsEqual, agentSectionHref, isAgentRouteId } from "@/lib/agent-routes";

export type AcceptedDeploymentNavigate = (options: {
	href: string;
	replace: boolean;
}) => void | Promise<void>;

type AcceptedDeploymentRequestResolver = (
	deployRequestId: string,
) => Promise<{ agentId?: string | null; deploymentId: string }>;

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

async function hydrateAcceptedDeployment({
	agentId,
	deploymentId,
	getDeployment,
	queryClient,
}: {
	agentId?: string;
	deploymentId: string;
	getDeployment: (deploymentId: string) => Promise<HostedDeployment>;
	queryClient: QueryClient;
}): Promise<HostedDeployment> {
	const authoritative = await getDeployment(deploymentId);
	if (authoritative.resource.id !== deploymentId) {
		throw new Error("The deployment service returned a different deployment.");
	}
	if (!isAgentRouteId(authoritative.agent_id)) {
		throw new Error("The deployment service returned an invalid Agent identity.");
	}
	if (agentId && !agentRouteIdsEqual(authoritative.agent_id, agentId)) {
		throw new Error("The deployment service returned a different Agent identity.");
	}

	// A list read that started before acceptance can be older than the committed
	// by-id row. Cancel it before the upsert so it cannot erase this handoff.
	await queryClient.cancelQueries({ queryKey: billingKeys.deployments, exact: true });
	queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, (deployments) =>
		upsertAuthoritativeDeployment(deployments, authoritative),
	);
	void queryClient.invalidateQueries({ queryKey: ["get", "/v1/agents"] });
	return authoritative;
}

/** Open accepted authority immediately when the API already returned its canonical Agent ID. */
export async function navigateToAcceptedDeployment({
	agentId,
	deploymentId,
	getDeployment,
	navigate,
	queryClient,
	replace = false,
}: {
	agentId?: string | null;
	deploymentId: string;
	getDeployment: (deploymentId: string) => Promise<HostedDeployment>;
	navigate: AcceptedDeploymentNavigate;
	queryClient: QueryClient;
	replace?: boolean;
}): Promise<void> {
	const acceptedAgentId = agentId?.trim() || null;
	if (acceptedAgentId && !isAgentRouteId(acceptedAgentId)) {
		throw new Error("The deployment service returned an invalid Agent identity.");
	}

	if (acceptedAgentId) {
		const hydration = hydrateAcceptedDeployment({
			agentId: acceptedAgentId,
			deploymentId,
			getDeployment,
			queryClient,
		}).catch(() => {
			void queryClient.invalidateQueries({ queryKey: billingKeys.deployments, exact: true });
		});
		await navigate({ href: agentSectionHref(acceptedAgentId), replace });
		void hydration;
		return;
	}

	const authoritative = await hydrateAcceptedDeployment({
		deploymentId,
		getDeployment,
		queryClient,
	});

	await navigate({
		href: agentSectionHref(authoritative.agent_id),
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
	const { agentId, deploymentId } = await resolveDeploymentRequest(deployRequestId);
	onAccepted?.();
	await navigateToAcceptedDeployment({ ...navigation, agentId, deploymentId });
}
