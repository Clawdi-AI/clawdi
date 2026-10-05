import { AgentRow, useCloudAgents } from "../../src/features/cloud-inventory";
import { InventoryList } from "../../src/features/inventory-list";
import { ProjectResourceBoundary, ProjectScopeHeader } from "../../src/features/project-scope";
import { useI18n } from "../../src/i18n";
import { LoadingScreen } from "../../src/ui/feedback";

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
	if (agents.isPending) return <LoadingScreen label={t("loading.agents")} />;
	return (
		<InventoryList
			header={<ProjectScopeHeader project={project} />}
			items={agents.data ?? []}
			title={t("agents.title")}
			description={t(project ? "projects.agentsScope" : "agents.description")}
			empty={t("agents.empty")}
			renderItem={(agent) => <AgentRow agent={agent} />}
			refreshing={agents.isRefetching}
			onRefresh={() => {
				if (!agents.isFetching) void agents.refetch();
			}}
			error={agents.isError}
			busy={agents.isFetching}
			onRetry={() => void agents.refetch()}
		/>
	);
}

import type { Project } from "@clawdi/shared/api";
