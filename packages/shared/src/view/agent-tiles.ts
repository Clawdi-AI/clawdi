import type { components } from "../api/api.generated";
import { agentDisplayName, agentIdentity, compareAgentEnvironments } from "./agent-label";
import { type DaemonStatusVisual, daemonStatusVisual } from "./daemon-status";
import { relativeTime } from "./utils";

type Env = components["schemas"]["AgentResponse"];

/**
 * Build self-managed AgentTiles from cloud-api environments. Shared by the
 * Overview grid and the `/agents` index so the tile shape stays identical
 * across both surfaces (single source of truth for the connected-agent row).
 */
export function selfManagedAgentTiles(environments: Env[] | undefined): AgentTile[] {
	return (environments ?? []).map((env) => ({
		id: env.id,
		source: "self-managed" as const,
		name: agentDisplayName(env),
		avatarUrl: env.avatar_url,
		sortOrder: env.sort_order,
		agentType: env.agent_type,
		href: `/agents/${encodeURIComponent(env.id)}`,
		env,
	}));
}

export type AgentCardStatusVisual = Pick<DaemonStatusVisual, "label" | "tooltip" | "dotClass">;

export interface AgentCardStatusProjection {
	visual: AgentCardStatusVisual;
	/** Explicit status labels rendered in the compact card metadata. */
	labels: string[];
}

/**
 * UI-side projection of an agent for the dashboard grid. The dashboard
 * page composes this from cloud-api environments and (for hosted users)
 * hosted deployments — `AgentsCard` itself stays generic and
 * never imports cross-origin clients or `@/hosted/*`.
 */
export interface AgentTile {
	id: string;
	source: "self-managed" | "on-clawdi" | "legacy-hosted";
	name: string;
	avatarUrl?: string | null;
	sortOrder?: number | null;
	agentType: string | null;
	/** Primary click target. Points at the canonical Agent UUID route. */
	href: string | null;
	external?: boolean;
	/** Optional remediation target for legacy status dialogs. */
	manageHref?: string;
	/** Hosted integrations can project compute-first status without making the
	 * generic card import hosted lifecycle types. */
	cardStatus?: AgentCardStatusProjection;
	/** Whether this hosted deployment has an authoritative Files endpoint. */
	filesAvailable?: boolean;
	/** Self-managed Agents carry their full response so the tile can render a
	 * sync indicator. Hosted tiles attach an observed Cloud projection when it
	 * exists; deployment authority remains available when it does not. */
	env?: Env | null;
}

/**
 * The compact card projects sync only from a real Cloud API environment.
 * A v2 deployment can exist before that projection arrives; rendering the
 * daemon's null-env "pending" state there would turn missing data into a
 * reassuring status. Self-managed and legacy tiles retain their established
 * setup status because their environment record is their source of truth.
 * Metadata is intentionally limited to the highest-priority available label.
 */
export function agentTileCardProjection(tile: AgentTile): {
	meta: [] | [string];
	statusVisual: AgentCardStatusVisual | null;
} {
	const identity = agentIdentity({
		name: tile.name,
		machine_name: tile.name,
		agent_type: tile.agentType,
	});
	const metaLabel =
		tile.cardStatus?.labels[0] ?? agentTileActivityLabel(tile) ?? identity.secondaryLabel;
	const statusVisual = tile.cardStatus
		? tile.cardStatus.visual
		: tile.source === "on-clawdi" && !tile.env
			? null
			: daemonStatusVisual(tile.env, tile.source === "self-managed" ? "self-managed" : "on-clawdi");
	return { meta: metaLabel ? [metaLabel] : [], statusVisual };
}

function agentTileActivityLabel(tile: AgentTile): string | null {
	if (tile.env?.last_sync_at) return `Synced ${relativeTime(tile.env.last_sync_at)}`;
	if (tile.env?.last_seen_at) return `Seen ${relativeTime(tile.env.last_seen_at)}`;
	return null;
}

export function compareAgentTiles(a: AgentTile, b: AgentTile): number {
	if (a.env && b.env) return compareAgentEnvironments(a.env, b.env);
	const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
	const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
	if (aOrder !== bOrder) return aOrder - bOrder;
	const name = a.name.localeCompare(b.name);
	if (name !== 0) return name;
	return a.id.localeCompare(b.id);
}
