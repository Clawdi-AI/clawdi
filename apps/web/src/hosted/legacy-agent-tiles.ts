import type { components } from "@clawdi/shared/api";
import { cleanMachineName } from "@/components/dashboard/agent-label";
import {
	type AgentTile,
	formatRuntime,
	isAgentActive,
	isHostedManagedEnv,
} from "@/components/dashboard/agents-card";
import { agentSectionHref } from "@/lib/agent-routes";
import { relativeTime } from "@/lib/utils";

type Env = components["schemas"]["EnvironmentResponse"];

/**
 * Fallback projection for legacy v1 environments that are already present in
 * cloud-api but intentionally not fetched through the Cloud deploy API.
 * Product-wise these behave like connected agents in the new dashboard; their
 * v1-only management surface stays behind the separate legacy dashboard entry.
 */
export function legacyConnectedAgentTiles(environments: Env[] | undefined): AgentTile[] {
	return (environments ?? []).filter(isHostedManagedEnv).map((env) => ({
		id: env.id,
		source: "self-managed" as const,
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
		active: isAgentActive(env.last_seen_at),
		env,
	}));
}
