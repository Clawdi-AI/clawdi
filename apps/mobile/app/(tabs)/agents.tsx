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
import { useCloudAgents } from "../../src/features/cloud-inventory";
import { ProjectResourceBoundary, ProjectScopeHeader } from "../../src/features/project-scope";
import { Button } from "../../src/ui/button";
import { AgentsCard, AgentTileView } from "../../src/ui/dashboard/agents-card";
import { useDashboardAgents } from "../../src/ui/dashboard/use-dashboard-agents";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../src/ui/dialog";
import { Icon } from "../../src/ui/icon";
import { PageHeader } from "../../src/ui/page-header";
import { AppScrollView } from "../../src/ui/primitives";
import { ReadScreen } from "../../src/ui/read-screen";
import { SectionLabel } from "../../src/ui/section-label";
import { StatusBadge } from "../../src/ui/status-badge";
import { Text } from "../../src/ui/text";
import { WebView, webBoth, webView } from "../../src/ui/web-layout";
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
		<ReadScreen>
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
		</ReadScreen>
	);
}
