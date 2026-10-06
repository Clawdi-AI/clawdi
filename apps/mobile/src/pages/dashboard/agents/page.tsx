import type { Project } from "@clawdi/shared/api";
import {
	agentSourceBadgeClasses,
	agentsIndexClasses,
	ENTITY_GRID_CLASS,
	hostedAgentGroupsClasses,
} from "@clawdi/shared/ui";
import {
	agentSourceLabel,
	agentSurfaceCopy,
	hostedAgentCountLabel,
	hostedAgentGroupsCopy,
	selfManagedAgentTiles,
} from "@clawdi/shared/view";
import { Cloud } from "lucide-react-native";
import { useState } from "react";
import { RefreshControl } from "react-native";
import { AgentsCard, AgentTileView } from "@/components/dashboard/agents-card";
import { PageHeader } from "@/components/page-header";
import { ProjectResourceBoundary, ProjectScopeHeader } from "@/components/projects/project-scope";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { AppScrollView } from "@/components/ui/view";
import { WebView, webBoth, webView } from "@/components/ui/web-layout";
import { useCloudAgents } from "@/hooks/cloud-inventory";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
export default function AgentsRoute() {
	return (
		<ProjectResourceBoundary>
			{(project) => <AgentsView project={project} />}
		</ProjectResourceBoundary>
	);
}
function AgentsView({ project }: { project?: Project }) {
	const agents = useCloudAgents(project?.id);
	const dashboard = useDashboardAgents();
	const [scopeOpen, setScopeOpen] = useState(false);
	const hostedTiles = dashboard.tiles.filter((tile) => tile.source === "on-clawdi");
	const otherTiles = dashboard.tiles.filter((tile) => tile.source !== "on-clawdi");
	return (
		<SafeAreaScreen>
			<AppScrollView
				contentContainerClassName={webView(agentsIndexClasses.page)}
				refreshControl={
					<RefreshControl
						refreshing={agents.isRefetching}
						onRefresh={() => void agents.refetch()}
					/>
				}
			>
				<PageHeader
					title={agentSurfaceCopy.agents}
					description={agentSurfaceCopy.everyAgentInYourAccount}
					titleAdornment={
						<Button
							variant="ghost"
							size="icon-xs"
							accessibilityLabel="Project scope"
							onPress={() => setScopeOpen(true)}
						>
							<Text>⋯</Text>
						</Button>
					}
				/>
				<Dialog open={scopeOpen} onOpenChange={setScopeOpen}>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Project scope</DialogTitle>
						</DialogHeader>
						<ProjectScopeHeader project={project} />
					</DialogContent>
				</Dialog>
				{!project &&
				!dashboard.agents.isPending &&
				!dashboard.hostedStatus?.isLoading &&
				!dashboard.hostedStatus?.error &&
				dashboard.tiles.length ? (
					<WebView recipe={hostedAgentGroupsClasses.root}>
						{hostedTiles.length ? (
							<WebView recipe={hostedAgentGroupsClasses.section}>
								<SectionLabel
									count={hostedAgentCountLabel(hostedTiles.length)}
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
											<Text>{agentSourceLabel("hosted")}</Text>
										</StatusBadge>
									}
								>
									{hostedAgentGroupsCopy.cloud}
								</SectionLabel>
								<WebView recipe={ENTITY_GRID_CLASS}>
									{hostedTiles.map((tile) => (
										<AgentTileView key={tile.id} tile={tile} />
									))}
								</WebView>
							</WebView>
						) : null}
						{otherTiles.length ? (
							<WebView recipe={hostedAgentGroupsClasses.section}>
								<SectionLabel>{hostedAgentGroupsCopy.other}</SectionLabel>
								<WebView recipe={ENTITY_GRID_CLASS}>
									{otherTiles.map((tile) => (
										<AgentTileView key={tile.id} tile={tile} />
									))}
								</WebView>
							</WebView>
						) : null}
					</WebView>
				) : (
					<AgentsCard
						agents={project ? selfManagedAgentTiles(agents.data) : dashboard.tiles}
						isLoading={
							project
								? agents.isPending
								: dashboard.agents.isPending || dashboard.hostedStatus?.isLoading === true
						}
						error={
							project
								? agents.data
									? null
									: agents.error
								: (dashboard.hostedStatus?.error ??
									(dashboard.agents.data ? null : dashboard.agents.error))
						}
						onRetry={() => {
							void agents.refetch();
							if (!project) dashboard.hostedStatus?.onRetry();
						}}
					/>
				)}
			</AppScrollView>
		</SafeAreaScreen>
	);
}
