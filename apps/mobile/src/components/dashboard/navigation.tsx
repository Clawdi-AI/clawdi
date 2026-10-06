import { resolveAgentWorkspaceProjectId } from "@clawdi/shared/api";
import {
	AGENT_NAVIGATION_GROUPS,
	agentSectionCopy,
	type MobileAgentSection,
	runtimeBrowserUiLabel,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { agentSectionHref } from "@/lib/agent-routes";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { NativeHeader } from "@/platform/navigation/native-header";
export function AgentSectionNavigation({
	agentId,
	section = "overview",
}: {
	agentId: string;
	section?: MobileAgentSection | "console" | "files" | "terminal";
}) {
	const inventory = useDashboardAgents();
	const deployment = inventory.inventory.data?.find((d) => d.agent_id === agentId);
	const scope = useAccountScope(),
		read = useAccountRead(),
		{ agentProjects } = useMobileApi(),
		agent = useCloudAgent(agentId);
	const bindings = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-bindings", agentId),
		enabled: scope.isReady,
		retry: false,
		queryFn: ({ signal }) => read((lease) => agentProjects.listBindings(agentId, lease), signal),
	});
	const workspace = resolveAgentWorkspaceProjectId(
		bindings.data ?? [],
		agent.data?.default_project_id,
	);
	const sections = AGENT_NAVIGATION_GROUPS.flatMap((group) =>
		group.id === "workspace" ? [...group.itemIds, "skills", "vaults"] : group.itemIds,
	).filter((id): id is MobileAgentSection => id in agentSectionCopy);
	return (
		<NativeHeader
			actions={
				section === "projects"
					? [
							{
								id: "create-project",
								label: "Create Project",
								onPress: () =>
									router.push({
										pathname: "/agents/[id]/project-access/new",
										params: { id: agentId },
									}),
							},
						]
					: section === "skills"
						? [
								{
									id: "install-skill",
									label: "Install Skill",
									onPress: () =>
										router.push({
											pathname: deployment
												? "/agents/[id]/skills/browse"
												: "/agents/[id]/skills/install",
											params: { id: agentId },
										}),
								},
							]
						: undefined
			}
			menu={{
				label: "Agent sections",
				items: [
					...(deployment
						? [
								{
									id: "compute",
									label: "Agent settings",
									onPress: () =>
										router.push({ pathname: "/agents/[id]/compute", params: { id: agentId } }),
								},
							]
						: []),
					...Array.from(new Set(sections)).map((id) => ({
						id,
						label: agentSectionCopy[id].label,
						disabled: section === id || (id === "vaults" && (!workspace || bindings.isError)),
						onPress: () => router.push(agentSectionHref(agentId, id)),
					})),
					...(deployment
						? [
								{
									id: "console-entry",
									label: runtimeBrowserUiLabel(deployment.resource.spec.runtime),
									onPress: () => router.push(`/agents/${agentId}/console`),
								},
								{
									id: "terminal-entry",
									label: "Terminal",
									onPress: () =>
										router.push({ pathname: "/terminal/[id]", params: { id: agentId } }),
								},
							]
						: []),
				],
			}}
		/>
	);
}
