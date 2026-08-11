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
	const envId = normalizeAgentEnvId(id);
	return Boolean(envId && (claimedEnvIds.has(envId) || legacyEnvIds.has(envId)));
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
	const legacy = useLegacyEnvIds();
	const selection = useMemo(
		() =>
			selectUnifiedAgentList({
				cloudEnvs,
				hostedTiles: hosted.tiles,
				claimedEnvIds: hosted.claimedEnvIds,
				legacyEnvIds: legacy.envIds,
				hostedInventoryStatus: hosted.inventoryStatus,
				showLegacyAgents,
			}),
		[
			cloudEnvs,
			hosted.claimedEnvIds,
			hosted.inventoryStatus,
			hosted.tiles,
			legacy.envIds,
			showLegacyAgents,
		],
	);

	return {
		...selection,
		hasExistingDeployments: hosted.hasExistingDeployments,
		inventoryStatus: hosted.inventoryStatus,
		isFetching: hosted.isFetching,
		isLoading: (showCloudDeployments && hosted.isLoading) || legacy.isLoading,
		error: hosted.error ?? legacy.error,
		refetch: () =>
			Promise.all([...(showCloudDeployments ? [hosted.refetch()] : []), legacy.refetch()]),
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
	onChange: (
		tiles: AgentTile[] | null,
		membershipResolved: boolean,
		inventoryFetching: boolean,
	) => void;
}) {
	const unified = useUnifiedAgentList({
		cloudEnvs,
		showCloudDeployments,
		showLegacyAgents,
	});

	useEffect(() => {
		onChange(unified.tiles, unified.membershipResolved, unified.isFetching);
	}, [onChange, unified.isFetching, unified.membershipResolved, unified.tiles]);
	useEffect(() => () => onChange(null, false, false), [onChange]);

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
