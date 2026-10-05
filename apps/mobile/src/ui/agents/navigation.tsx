import { resolveAgentWorkspaceProjectId } from "@clawdi/shared/api";
import {
	AGENT_NAVIGATION_GROUPS,
	agentSectionCopy,
	type MobileAgentSection,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { useCloudAgent } from "../../features/cloud-inventory";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useMobileApi } from "../../providers/api-provider";
import { Button } from "../button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../dialog";
import { SectionLabel } from "../section-label";
import { Text } from "../text";
import { AppView } from "../view";
export function AgentSectionNavigation({
	agentId,
	section = "overview",
}: {
	agentId: string;
	section?: MobileAgentSection;
}) {
	const [open, setOpen] = useState(false);
	const scope = useAccountScope(),
		read = useAccountRead(),
		{ agentProjects } = useMobileApi(),
		agent = useCloudAgent(agentId);
	const bindings = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-bindings", agentId),
		enabled: scope.isReady && open,
		retry: false,
		queryFn: ({ signal }) => read((lease) => agentProjects.listBindings(agentId, lease), signal),
	});
	const workspace = resolveAgentWorkspaceProjectId(
		bindings.data ?? [],
		agent.data?.default_project_id,
	);
	const navigate = (next: MobileAgentSection) => {
		setOpen(false);
		switch (next) {
			case "overview":
				router.push({ pathname: "/agents/[agentId]", params: { agentId } });
				break;
			case "sessions":
				router.push({ pathname: "/sessions", params: { agentId } });
				break;
			case "memories":
				router.push("/memories");
				break;
			case "connectors":
				router.push("/connectors");
				break;
			case "vaults":
				if (workspace) router.push({ pathname: "/vault", params: { projectId: workspace } });
				break;
			case "ai":
				router.push({ pathname: "/ai-providers", params: { agentId } });
				break;
			case "channels":
				router.push({ pathname: "/channels", params: { agentId } });
				break;
			case "projects":
				router.push({ pathname: "/agents/[agentId]/projects", params: { agentId } });
				break;
			case "skills":
				router.push({ pathname: "/agents/[agentId]/skills", params: { agentId } });
				break;
			case "plugins":
				router.push({ pathname: "/agents/[agentId]/plugins", params: { agentId } });
				break;
			case "settings":
				router.push({ pathname: "/agents/[agentId]/settings", params: { agentId } });
				break;
		}
	};
	return (
		<>
			<AppView className="flex-row justify-between">
				<Button variant="ghost" size="sm" onPress={() => router.push("/(tabs)/agents")}>
					<Text>← Agents</Text>
				</Button>
				<Button variant="ghost" size="sm" onPress={() => setOpen(true)}>
					<Text>{agentSectionCopy[section].label} ▾</Text>
				</Button>
			</AppView>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Agent sections</DialogTitle>
					</DialogHeader>
					{AGENT_NAVIGATION_GROUPS.map((group) => (
						<AppView key={group.id}>
							{group.label ? <SectionLabel>{group.label}</SectionLabel> : null}
							{(group.id === "workspace"
								? ([...group.itemIds, "skills", "vaults"] as const)
								: group.itemIds
							)
								.filter((id): id is MobileAgentSection => id in agentSectionCopy)
								.map((id) => (
									<Button
										key={id}
										variant={section === id ? "secondary" : "ghost"}
										disabled={id === "vaults" && (!workspace || bindings.isError)}
										onPress={() => navigate(id)}
									>
										<Text>{agentSectionCopy[id].label}</Text>
									</Button>
								))}
						</AppView>
					))}
				</DialogContent>
			</Dialog>
		</>
	);
}
