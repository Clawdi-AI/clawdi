import type { components } from "@clawdi/shared/api";
import { cleanMachineName } from "@/components/dashboard/agent-label";
import {
	type AgentTile,
	formatRuntime,
	isAgentActive,
	isHostedManagedEnv,
} from "@/components/dashboard/agents-card";
import { agentSectionHref } from "@/lib/agent-routes";
import { legacyHostedDashboardUrl } from "@/lib/legacy-hosted-dashboard";
import { relativeTime } from "@/lib/utils";

type Env = components["schemas"]["EnvironmentResponse"];

/**
 * Fallback projection for legacy v1 environments that are already present in
 * cloud-api but intentionally not fetched through the Cloud deploy API.
 * Product-wise these behave like connected agents in the new dashboard; their
 * v1-only management surface stays behind the separate legacy dashboard entry.
 *
 * `source: "legacy-hosted"` gives the tile the Legacy pill (the v1 counterpart
 * of the Cloud pill on deploy-API tiles). The tile keeps `env`: v1 runtimes
 * run the real clawdi daemon with live sync on, so the sync badge carries real
 * signal — AgentTileView renders it with the hosted copy variant (supervised
 * daemon, no CLI instructions), and `manageHref` points remediation at the
 * legacy dashboard when its URL is configured.
 *
 * `claimedEnvIds` (lower-cased env ids, from `useHostedAgentTiles`) excludes
 * environments already represented by a Cloud deploy-API tile so an env is
 * never shown twice.
 */
export function legacyConnectedAgentTiles(
	environments: Env[] | undefined,
	claimedEnvIds?: ReadonlySet<string>,
): AgentTile[] {
	const manageHref = legacyHostedDashboardUrl() ?? undefined;
	return (environments ?? [])
		.filter(isHostedManagedEnv)
		.filter((env) => !claimedEnvIds?.has(env.id.toLowerCase()))
		.map((env) => ({
			id: env.id,
			source: "legacy-hosted" as const,
			name:
				cleanMachineName(env.display_name) ||
				cleanMachineName(env.machine_name) ||
				formatRuntime(env.agent_type),
			displayName: env.display_name,
			avatarUrl: env.avatar_url,
			sortOrder: env.sort_order,
			agentType: env.agent_type,
			runtimeLabel: formatRuntime(env.agent_type),
			statusLabel: env.last_seen_at ? `Active ${relativeTime(env.last_seen_at)}` : "Never seen",
			lastSeenAt: env.last_seen_at,
			href: agentSectionHref(env.id),
			manageHref,
			active: isAgentActive(env.last_seen_at),
			env,
		}));
}
