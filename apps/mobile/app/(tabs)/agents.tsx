import type { Project } from "@clawdi/shared/api";
import { agentsIndexClasses } from "@clawdi/shared/ui";
import { agentSurfaceCopy, selfManagedAgentTiles } from "@clawdi/shared/view";
import { useState } from "react";
import { RefreshControl } from "react-native";
import { useCloudAgents } from "../../src/features/cloud-inventory";
import { ProjectResourceBoundary, ProjectScopeHeader } from "../../src/features/project-scope";
import { AgentsCard } from "../../src/ui/agents/agents-card";
import { Button } from "../../src/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../src/ui/dialog";
import { PageHeader } from "../../src/ui/page-header";
import { AppScrollView } from "../../src/ui/primitives";
import { ReadScreen } from "../../src/ui/read-screen";
import { Text } from "../../src/ui/text";
import { webView } from "../../src/ui/web-layout";
export default function AgentsRoute() {
	return (
		<ProjectResourceBoundary>
			{(project) => <AgentsView project={project} />}
		</ProjectResourceBoundary>
	);
}
function AgentsView({ project }: { project?: Project }) {
	const agents = useCloudAgents(project?.id);
	const [scopeOpen, setScopeOpen] = useState(false);
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
				<AgentsCard
					agents={selfManagedAgentTiles(agents.data)}
					isLoading={agents.isPending}
					error={agents.data ? null : agents.error}
					onRetry={() => void agents.refetch()}
				/>
			</AppScrollView>
		</ReadScreen>
	);
}
