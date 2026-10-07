import type { Project } from "@clawdi/shared/api";
import { agentSourceBadgeClasses, hostedAgentGroupsClasses } from "@clawdi/shared/ui";
import {
	agentSourceKindLabel,
	agentSurfaceCopy,
	hostedAgentCountLabel,
	hostedAgentGroupsCopy,
	selfManagedAgentTiles,
} from "@clawdi/shared/view";
import { router } from "expo-router";
import { Cloud } from "lucide-react-native";
import { AgentsCard, AgentTileView } from "@/components/dashboard/agents-card";
import { PageHeader } from "@/components/page-header";
import { ProjectResourceBoundary } from "@/components/projects/project-scope";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { SectionLabel } from "@/components/section-label";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { WebView, webBoth } from "@/components/ui/web-layout";
import { useCloudAgents } from "@/hooks/cloud-inventory";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { useI18n } from "@/lib/i18n";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
export default function AgentsRoute() {
	return (
		<ProjectResourceBoundary>
			{(project) => <AgentsView project={project} />}
		</ProjectResourceBoundary>
	);
}
function AgentsView({ project }: { project?: Project }) {
	const t = useI18n();
	const agents = useCloudAgents(project?.id);
	const dashboard = useDashboardAgents();
	const projects = useCloudProjects();
	const loading = project
		? agents.isPending
		: dashboard.agents.isPending || dashboard.hostedStatus?.isLoading === true;
	const error = project
		? agents.data
			? null
			: agents.error
		: (dashboard.hostedStatus?.error ?? (dashboard.agents.data ? null : dashboard.agents.error));
	const tiles = project ? selfManagedAgentTiles(agents.data) : dashboard.tiles;
	const hosted = tiles.filter((tile) => tile.source === "on-clawdi");
	const other = tiles.filter((tile) => tile.source !== "on-clawdi");
	const rows = loading || error ? [] : [...hosted, ...other];
	const refresh = () => {
		void agents.refetch();
		if (!project) {
			void dashboard.agents.refetch();
			dashboard.hostedStatus?.onRetry();
		}
	};
	return (
		<SafeAreaScreen>
			<NativeHeader
				title={agentSurfaceCopy.agents}
				actions={[
					{ id: "create", label: t("agents.create"), onPress: () => router.push("/deploy") },
				]}
				menu={{
					label: t("projects.filter"),
					items: [
						{
							id: "all",
							label: t("projects.all"),
							onPress: () => router.setParams({ projectId: undefined }),
						},
						...(projects.data ?? []).map((item) => ({
							id: item.id,
							label: item.name,
							onPress: () => router.setParams({ projectId: item.id }),
						})),
					],
				}}
			/>
			<NativeList
				data={rows}
				keyExtractor={(tile) => `${tile.source}:${tile.id}`}
				refreshing={agents.isRefetching || dashboard.agents.isRefetching}
				onRefresh={refresh}
				header={
					<PageHeader
						title={agentSurfaceCopy.agents}
						description={agentSurfaceCopy.everyAgentInYourAccount}
					/>
				}
				empty={<AgentsCard agents={[]} isLoading={loading} error={error} onRetry={refresh} />}
				renderItem={({ item, index }) => (
					<WebView recipe={hostedAgentGroupsClasses.section}>
						{!project && (index === 0 || index === hosted.length) ? (
							item.source === "on-clawdi" ? (
								<SectionLabel
									count={hostedAgentCountLabel(hosted.length)}
									leading={
										<StatusBadge
											className={webBoth(
												`${agentSourceBadgeClasses.root} ${agentSourceBadgeClasses.compact} ${agentSourceBadgeClasses.hosted}`,
											)}
										>
											<Icon
												as={Cloud}
												fill="currentColor"
												className={webBoth(agentSourceBadgeClasses.icon)}
											/>
											<Text>{agentSourceKindLabel("hosted")}</Text>
										</StatusBadge>
									}
								>
									{hostedAgentGroupsCopy.cloud}
								</SectionLabel>
							) : (
								<SectionLabel>{hostedAgentGroupsCopy.other}</SectionLabel>
							)
						) : null}
						<AgentTileView tile={item} />
					</WebView>
				)}
			/>
		</SafeAreaScreen>
	);
}
