import type { components } from "@clawdi/shared/api";
import { legacyConnectedAgentTiles as projectLegacyTiles } from "@clawdi/shared/view";
import { legacyHostedDashboardUrl } from "@/hosted/access/legacy-dashboard-url";
export function legacyConnectedAgentTiles(
	environments: components["schemas"]["AgentResponse"][] | undefined,
	legacyEnvIds: ReadonlySet<string>,
	claimedEnvIds?: ReadonlySet<string>,
) {
	return projectLegacyTiles(
		environments,
		legacyEnvIds,
		claimedEnvIds,
		legacyHostedDashboardUrl() ?? undefined,
	);
}
