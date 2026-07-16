"use client";

import type { components } from "@clawdi/shared/api";
import { type ReactNode, useEffect, useMemo } from "react";
import {
	type AgentFleetSummary,
	type AgentTile,
	fleetSummaryFromTiles,
	selfManagedAgentTiles,
} from "@/components/dashboard/agents-card";
import { useLegacyEnvIds } from "@/hosted/agents/ownership-sensor";
import type { HostedInventoryStatus } from "@/hosted/hosted-agent-resolution";
import { legacyConnectedAgentTiles } from "@/hosted/legacy-agent-tiles";
import { useHostedAgentTiles } from "@/hosted/use-hosted-agent-tiles";
import { normalizeAgentEnvId } from "@/lib/agent-ownership";

type Env = components["schemas"]["AgentResponse"];

const EMPTY_ENV_IDS: ReadonlySet<string> = new Set();

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
	const membershipResolved =
		hostedInventoryStatus === "resolved" && (!showLegacyAgents || legacyEnvIds !== null);
	if (!membershipResolved) {
		return {
			tiles: hostedTiles,
			hostedTiles,
			connectedTiles: [],
			membershipResolved: false,
		};
	}

	const legacyConnectedTiles =
		showLegacyAgents && legacyEnvIds
			? legacyConnectedAgentTiles(cloudEnvs, legacyEnvIds, claimedEnvIds)
			: [];
	const dedupedSelfManaged = selfManagedAgentTiles(cloudEnvs).filter(
		(tile) =>
			!isOwnedEnvId(tile.id, claimedEnvIds, showLegacyAgents ? legacyEnvIds : EMPTY_ENV_IDS),
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
	legacyEnvIds: ReadonlySet<string> | null,
): boolean {
	const envId = normalizeAgentEnvId(id);
	return Boolean(envId && (claimedEnvIds.has(envId) || legacyEnvIds?.has(envId)));
}

export function useUnifiedAgentList({
	cloudEnvs,
	showCloudDeployments = true,
	showLegacyAgents = false,
}: {
	cloudEnvs: Env[];
	showCloudDeployments?: boolean;
	showLegacyAgents?: boolean;
}) {
	const hosted = useHostedAgentTiles({
		cloudEnvs,
		includeDeployments: showCloudDeployments,
	});
	const resolvedLegacyEnvIds = useLegacyEnvIds();
	const legacyEnvIds = showLegacyAgents ? resolvedLegacyEnvIds : EMPTY_ENV_IDS;
	const selection = useMemo(
		() =>
			selectUnifiedAgentList({
				cloudEnvs,
				hostedTiles: hosted.tiles,
				claimedEnvIds: hosted.claimedEnvIds,
				legacyEnvIds,
				hostedInventoryStatus: hosted.inventoryStatus,
				showLegacyAgents,
			}),
		[
			cloudEnvs,
			hosted.claimedEnvIds,
			hosted.inventoryStatus,
			hosted.tiles,
			legacyEnvIds,
			showLegacyAgents,
		],
	);

	return {
		...selection,
		hasExistingDeployments: hosted.hasExistingDeployments,
		inventoryStatus: hosted.inventoryStatus,
		isLoading:
			(showCloudDeployments && hosted.isLoading) ||
			(showLegacyAgents && resolvedLegacyEnvIds === null),
		error: hosted.error,
		refetch: hosted.refetch,
	};
}

export function HostedUnifiedAgentListSensor({
	cloudEnvs,
	showCloudDeployments = true,
	showLegacyAgents = false,
	onChange,
}: {
	cloudEnvs: Env[];
	showCloudDeployments?: boolean;
	showLegacyAgents?: boolean;
	onChange: (tiles: AgentTile[] | null, membershipResolved: boolean) => void;
}) {
	const unified = useUnifiedAgentList({
		cloudEnvs,
		showCloudDeployments,
		showLegacyAgents,
	});

	useEffect(() => {
		onChange(unified.tiles, unified.membershipResolved);
	}, [onChange, unified.membershipResolved, unified.tiles]);
	useEffect(() => () => onChange(null, false), [onChange]);

	return null;
}

export function HostedFleetSummary({
	cloudEnvs,
	showCloudDeployments = true,
	showLegacyAgents = false,
	children,
}: {
	cloudEnvs: Env[];
	showCloudDeployments?: boolean;
	showLegacyAgents?: boolean;
	children: (
		summary: AgentFleetSummary,
		state: { membershipResolved: boolean; error: Error | null; isLoading: boolean },
	) => ReactNode;
}) {
	const unified = useUnifiedAgentList({
		cloudEnvs,
		showCloudDeployments,
		showLegacyAgents,
	});
	const summary = useMemo(() => fleetSummaryFromTiles(unified.tiles), [unified.tiles]);
	return children(summary, {
		membershipResolved: unified.membershipResolved,
		error: unified.error,
		isLoading: unified.isLoading,
	});
}
