import { resolveAgentWorkspaceProjectId } from "@clawdi/shared/api";
import {
	AGENT_NAVIGATION_GROUPS,
	agentSectionCopy,
	type MobileAgentSection,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { ArrowLeft, ChevronDown } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { useMobileApi } from "@/components/api-provider";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
export function AgentSectionNavigation({
	agentId,
	section = "overview",
	actions,
}: {
	agentId: string;
	section?: MobileAgentSection;
	actions?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const inventory = useDashboardAgents();
	const deployment = inventory.inventory.data?.find((d) => d.agent_id === agentId);
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
				if (workspace) router.push({ pathname: "/vault", params: { agentId } });
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
					<Icon as={ArrowLeft} />
					<Text>Agents</Text>
				</Button>
				<Button variant="ghost" size="sm" onPress={() => setOpen(true)}>
					<Text>{agentSectionCopy[section].label}</Text>
					<Icon as={ChevronDown} />
				</Button>
				{actions}
			</AppView>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Agent sections</DialogTitle>
					</DialogHeader>
					{AGENT_NAVIGATION_GROUPS.filter((group) =>
						group.itemIds.some((id) => id in agentSectionCopy),
					).map((group) => (
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
					{deployment ? (
						<Button
							variant="ghost"
							onPress={() => {
								setOpen(false);
								router.push({
									pathname: "/deployments/[deploymentId]/terminal",
									params: { deploymentId: deployment.resource.id },
								});
							}}
						>
							<Text>Terminal</Text>
						</Button>
					) : null}
				</DialogContent>
			</Dialog>
		</>
	);
}
