import {
	agentSurfaceCopy,
	agentToolSectionCopy,
	createProjectDialogCopy,
	type MobileAgentSection,
} from "@clawdi/shared/view";
import { router } from "expo-router";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { hostedAgentTitle } from "@/hosted/agent-title";
import { HeaderActions } from "@/platform/navigation/header-actions";
import { NativeHeader } from "@/platform/navigation/native-header";
import type { HeaderAction } from "@/platform/navigation/native-header-types";

/**
 * Agent section header. Sections are reached from the Agent overview rows (Web's sidebar groups),
 * so the header carries only the current section's actions. Like a native stack, the overview is
 * titled with the Agent and every other section with its own name, which the section's page
 * header (or, for Files, this header) sets; on iOS the back button then reads the Agent name.
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
	const actions: HeaderAction[] | undefined =
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
				: undefined;
	// One title owner per screen: page headers title the other sections.
	if (section === "overview")
		return (
			<NativeHeader title={hostedAgentTitle(agent.data, deployment) ?? ""} actions={actions} />
		);
	if (section === "files")
		return <NativeHeader title={agentToolSectionCopy.files.label} actions={actions} />;
	return actions ? <HeaderActions actions={actions} /> : null;
}
