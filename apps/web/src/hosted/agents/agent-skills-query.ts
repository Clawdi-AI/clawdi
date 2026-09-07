import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, useApi } from "@/lib/api";
import { useDeploymentEventStreamActive } from "@/lib/deployment-event-stream-context";
import { eventStreamFallbackInterval } from "@/lib/event-stream-refresh";

export function agentManagedSkillsKey(agentId: string) {
	return ["skills", "managed-agent", agentId] as const;
}

export function useAgentManagedSkills(agentId: string, enabled = true) {
	const api = useApi();
	const streamActive = useDeploymentEventStreamActive();
	return useQuery({
		queryKey: agentManagedSkillsKey(agentId),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}/skills", {
					params: { path: { agent_id: agentId } },
				}),
			),
		enabled,
		refetchInterval: eventStreamFallbackInterval(10_000, streamActive),
		refetchIntervalInBackground: false,
	});
}

export function useSkillReferenceMutation(agentId: string) {
	const api = useApi();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			action,
			skillId,
		}: {
			action: "install" | "uninstall";
			skillId: string;
		}) => {
			const params = { path: { agent_id: agentId, skill_id: skillId } };
			return action === "install"
				? unwrap(await api.PUT("/v1/agents/{agent_id}/skill-references/{skill_id}", { params }))
				: unwrap(await api.DELETE("/v1/agents/{agent_id}/skill-references/{skill_id}", { params }));
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["skills"] });
		},
	});
}
