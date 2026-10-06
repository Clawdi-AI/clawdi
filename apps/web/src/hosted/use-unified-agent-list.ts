"use client";
import { selectUnifiedAgentList } from "@clawdi/shared/view";

export { selectUnifiedAgentList, type UnifiedAgentListSelection } from "@clawdi/shared/view";

import type { components } from "@clawdi/shared/api";
import type { AgentTile } from "@clawdi/shared/view";
import { useEffect, useMemo } from "react";
import { useLegacyEnvIds } from "@/hosted/agents/ownership-sensor";
import { useHostedAgentTiles } from "@/hosted/use-hosted-agent-tiles";

type Env = components["schemas"]["AgentResponse"];

export function useUnifiedAgentList({
	cloudEnvs,
	showCloudDeployments = true,
	showLegacyAgents = false,
	eventStreamActive = false,
}: {
	cloudEnvs: Env[];
	showCloudDeployments?: boolean;
	showLegacyAgents?: boolean;
	eventStreamActive?: boolean;
}) {
	const hosted = useHostedAgentTiles({
		cloudEnvs,
		includeDeployments: showCloudDeployments,
		eventStreamActive,
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
