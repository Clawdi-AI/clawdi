import type { components } from "../api";
import { normalizeAgentId } from "../client";
import { agentDisplayName } from "./agent-label";
import { type AgentTile, selfManagedAgentTiles } from "./agent-tiles";

type Env = components["schemas"]["AgentResponse"];
type HostedInventoryStatus = "resolved" | "loading" | "error" | "unavailable";
export function legacyConnectedAgentTiles(
	environments: Env[] | undefined,
	legacyEnvIds: ReadonlySet<string>,
	claimedEnvIds?: ReadonlySet<string>,
	manageHref?: string,
): AgentTile[] {
	return (environments ?? [])
		.filter((env) => {
			const envId = normalizeAgentId(env.id);
			return Boolean(envId && legacyEnvIds.has(envId) && !claimedEnvIds?.has(envId));
		})
		.map((env) => ({
			id: env.id,
			source: "legacy-hosted" as const,
			name: agentDisplayName(env),
			avatarUrl: env.avatar_url,
			sortOrder: env.sort_order,
			agentType: env.agent_type,
			href: `/agents/${encodeURIComponent(env.id)}`,
			manageHref,
			env,
		}));
}
export interface UnifiedAgentListSelection {
	tiles: AgentTile[];
	hostedTiles: AgentTile[];
	connectedTiles: AgentTile[];
	membershipResolved: boolean;
}

/**
 * Canonical membership selector for every hosted dashboard agent list.
 *
 * A Cloud deployment owns its configured environment even while that
 * environment is absent from the Cloud API response. Legacy environments are
 * bridged once, and every remaining environment is rendered as self-managed.
 * `showLegacyAgents` controls their tiles, never whether ownership must resolve.
 */
export function selectUnifiedAgentList({
	cloudEnvs,
	hostedTiles,
	claimedEnvIds,
	legacyEnvIds,
	hostedInventoryStatus,
	showLegacyAgents,
}: {
	cloudEnvs: Env[];
	hostedTiles: AgentTile[];
	claimedEnvIds: ReadonlySet<string>;
	legacyEnvIds: ReadonlySet<string> | null;
	hostedInventoryStatus: HostedInventoryStatus;
	showLegacyAgents: boolean;
}): UnifiedAgentListSelection {
	if (hostedInventoryStatus !== "resolved" || legacyEnvIds === null) {
		return {
			tiles: hostedTiles,
			hostedTiles,
			connectedTiles: [],
			membershipResolved: false,
		};
	}

	const legacyConnectedTiles = showLegacyAgents
		? legacyConnectedAgentTiles(cloudEnvs, legacyEnvIds, claimedEnvIds)
		: [];
	const dedupedSelfManaged = selfManagedAgentTiles(cloudEnvs).filter(
		(tile) => !isOwnedEnvId(tile.id, claimedEnvIds, legacyEnvIds),
	);
	const connectedTiles = [...legacyConnectedTiles, ...dedupedSelfManaged];
	return {
		tiles: [...hostedTiles, ...connectedTiles],
		hostedTiles,
		connectedTiles,
		membershipResolved: true,
	};
}

function isOwnedEnvId(
	id: string,
	claimedEnvIds: ReadonlySet<string>,
	legacyEnvIds: ReadonlySet<string>,
): boolean {
	const envId = normalizeAgentId(id);
	return Boolean(envId && (claimedEnvIds.has(envId) || legacyEnvIds.has(envId)));
}

export const hostedAgentGroupsCopy = { cloud: "Clawdi Cloud", other: "Other agents" } as const;
export function hostedAgentCountLabel(count: number): string {
	return `${count} agent${count === 1 ? "" : "s"}`;
}
