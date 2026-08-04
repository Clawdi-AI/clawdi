"use client";

import { useMemo } from "react";
import {
	type AgentOverviewModuleContent,
	OverviewDescriptionSkeleton,
} from "@/components/dashboard/agent-overview-capabilities";
import { useOpenApi } from "@/lib/api";
import { isActiveConnection, useConnections } from "@/lib/connectors-data";

export function useOverviewMemoriesModule({
	enabled = true,
}: {
	enabled?: boolean;
} = {}): AgentOverviewModuleContent {
	const api = useOpenApi();
	const query = api.useQuery(
		"get",
		"/v1/memories",
		{ params: { query: { page: 1, page_size: 1 } } },
		{ enabled },
	);
	if (query.isLoading) return { description: <OverviewDescriptionSkeleton label="memories" /> };
	if (query.error) return { description: "Unavailable right now" };
	const total = query.data?.total ?? 0;
	return {
		description: total ? `${total} ${total === 1 ? "memory" : "memories"}` : "No memories yet",
	};
}

export function useOverviewConnectorsModule({
	enabled = true,
}: {
	enabled?: boolean;
} = {}): AgentOverviewModuleContent {
	const connections = useConnections({ enabled });
	const connectedAppCount = useMemo(
		() =>
			new Set(
				(connections.data ?? [])
					.filter(isActiveConnection)
					.flatMap((connection) => (connection.app_name ? [connection.app_name] : [])),
			).size,
		[connections.data],
	);
	const description = connections.isLoading ? (
		<OverviewDescriptionSkeleton label="apps" />
	) : connections.error ? (
		"Unavailable right now"
	) : connectedAppCount ? (
		`${connectedAppCount} connected`
	) : (
		"No apps connected"
	);
	return { description };
}
