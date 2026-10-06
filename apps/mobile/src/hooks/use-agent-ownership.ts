import {
	type AgentOwnership,
	EMPTY_AGENT_OWNERSHIP,
	normalizeAgentId,
} from "@clawdi/shared/client";
import { useQuery } from "@tanstack/react-query";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

export function useAgentOwnership() {
	const scope = useAccountScope();
	const read = useAccountRead();
	const { hosted, compute } = useMobileApi();
	return useQuery({
		queryKey: accountQueryKey(scope, "agent-ownership"),
		enabled: scope.isReady,
		retry: false,
		queryFn: ({ signal }) =>
			read(async (lease): Promise<AgentOwnership> => {
				if (!hosted || !compute) return EMPTY_AGENT_OWNERSHIP;
				const [deployments, capabilities] = await Promise.all([
					hosted.listDeployments(lease),
					compute.getProductCapabilities(lease),
				]);
				const legacyIds = capabilities.can_use_v1 ? await compute.getLegacyAgentIds(lease) : [];
				if (
					deployments.some(
						(deployment) => typeof deployment.agent_id !== "string" || !deployment.agent_id.trim(),
					)
				)
					throw new Error("Incomplete Agent ownership");
				const ids = (values: string[]) =>
					new Set(values.map(normalizeAgentId).filter((value): value is string => value !== null));
				return {
					cloudAgentIds: ids(deployments.map((deployment) => deployment.agent_id)),
					legacyAgentIds: ids(legacyIds),
					isResolved: true,
				};
			}, signal),
	});
}
