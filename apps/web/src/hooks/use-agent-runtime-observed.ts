import { useQuery } from "@tanstack/react-query";
import { unwrap, useApi } from "@/lib/api";

export function useAgentRuntimeObserved(agentId: string, enabled = true) {
	const api = useApi();
	return useQuery({
		queryKey: ["runtime-observed", agentId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}/runtime-observed", {
					params: { path: { agent_id: agentId } },
				}),
			),
		enabled,
	});
}

export function deploymentManagedMcpValue(
	desired: { has_mcp?: boolean } | null | undefined,
	unavailable: boolean,
): "Managed" | "Not managed" | "—" {
	if (unavailable || typeof desired?.has_mcp !== "boolean") return "—";
	return desired.has_mcp ? "Managed" : "Not managed";
}
