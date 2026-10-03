import { AgentRow, useCloudAgents } from "../../src/features/cloud-inventory";
import { InventoryList } from "../../src/features/inventory-list";
import { useI18n } from "../../src/i18n";
import { LoadingScreen } from "../../src/ui/feedback";

export default function AgentsRoute() {
	const t = useI18n();
	const agents = useCloudAgents();
	if (agents.isPending) return <LoadingScreen label={t("loading.agents")} />;
	return (
		<InventoryList
			items={agents.data ?? []}
			title={t("agents.title")}
			description={t("agents.description")}
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
