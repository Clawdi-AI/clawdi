import {
	agentDisplayName,
	agentSurfaceCopy,
	createProjectDialogCopy,
	type MobileAgentSection,
} from "@clawdi/shared/view";
import { router } from "expo-router";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { NativeHeader } from "@/platform/navigation/native-header";

/**
 * Agent section header. Sections are reached from the Agent overview rows (Web's sidebar groups),
 * so the header carries only the current section's actions.
 */
export function AgentSectionNavigation({
	agentId,
	section = "overview",
}: {
	agentId: string;
	section?: MobileAgentSection | "console" | "files" | "terminal";
}) {
	const inventory = useDashboardAgents();
	const deployment = inventory.inventory.data?.find((d) => d.agent_id === agentId);
	const agent = useCloudAgent(agentId);
	// Web's top bar names the Agent on every section; the Agent's own name wins, like the overview.
	const title = agent.data
		? agentDisplayName(agent.data)
		: deployment
			? agentDisplayName({
					default_name: deployment.resource.name,
					agent_type: deployment.resource.spec.runtime,
				})
			: "";
	return (
		<NativeHeader
			title={title}
			actions={
				section === "projects"
					? [
							{
								id: "create-project",
								label: createProjectDialogCopy.title,
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
									label: agentSurfaceCopy.installSkill,
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
		/>
	);
}
