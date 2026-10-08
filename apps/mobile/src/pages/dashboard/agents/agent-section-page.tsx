import {
	agentSectionAvailableDuringSetup,
	hostedDeploymentSetupInProgress,
} from "@clawdi/shared/view";
import { Redirect, useLocalSearchParams } from "expo-router";
import { AgentProjectsScreen } from "@/components/dashboard/agent-projects-tab";
import { AgentSettingsScreen } from "@/components/dashboard/agent-settings-panel";
import { AgentLibrarySkillsScreen } from "@/components/dashboard/workspace-skills-panel";
import { LibraryPage } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { VaultCatalogScreen } from "@/components/vault/vaults-surface";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { AgentPluginsScreen } from "@/hosted/v2/agent-plugins/agent-plugins-surface";
import { AiProvidersScreen } from "@/hosted/v2/ai-providers/ai-providers-page";
import { ChannelsScreen } from "@/hosted/v2/channels/channels-page";
import { agentSectionHref, parseAgentSectionSegment } from "@/lib/agent-routes";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import AgentDetailPage from "@/pages/dashboard/agents/agent-detail-client";
import ConnectorsPage from "@/pages/dashboard/connectors/page";
import MemoriesPage from "@/pages/dashboard/memories/page";
import SessionsPage from "@/pages/dashboard/sessions/page";
import TerminalPage from "@/pages/terminal-page";

export default function AgentSectionPage() {
	const t = useI18n();
	const params = useLocalSearchParams<{ id?: string | string[]; section?: string | string[] }>();
	const agentId = routeParam(params.id);
	const section = parseAgentSectionSegment(routeParam(params.section) ?? "");
	const deployment = useDashboardAgents().inventory.data?.find((d) => d.agent_id === agentId);
	// Sections that need the runtime return to the setup screen until it is ready.
	if (
		agentId &&
		section &&
		deployment &&
		hostedDeploymentSetupInProgress(deployment) &&
		!agentSectionAvailableDuringSetup(section)
	)
		return <Redirect href={agentSectionHref(agentId)} />;
	switch (section) {
		case "overview":
			return <AgentDetailPage />;
		case "sessions":
			return <SessionsPage />;
		case "memories":
			return <MemoriesPage />;
		case "connectors":
			return <ConnectorsPage />;
		case "projects":
			return <AgentProjectsScreen />;
		case "skills":
			return <AgentLibrarySkillsScreen />;
		case "vaults":
			return <VaultCatalogScreen />;
		case "ai":
			return <AiProvidersScreen />;
		case "channels":
			return <ChannelsScreen />;
		case "plugins":
			return <AgentPluginsScreen />;
		case "settings":
			return <AgentSettingsScreen />;
		case "terminal":
			return <TerminalPage />;
		// Existing runtime controls own console/files browser grants and lifecycle fences.
		case "console":
			return <AgentDetailPage section="console" />;
		case "files":
			return <AgentDetailPage section="files" />;
		default:
			return (
				<LibraryPage>
					<EmptyState title={t("agents.sectionUnavailable")} />
				</LibraryPage>
			);
	}
}

export function AgentSkillsPage() {
	return <AgentLibrarySkillsScreen />;
}
