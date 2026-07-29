"use client";

import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS, HeroCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentRuntimeObserved } from "@/hooks/use-agent-runtime-observed";
import {
	agentMcpInventoryMatchesDeployment,
	agentMcpInventoryQueryEnabled,
	agentMcpInventoryQueryKey,
	agentMcpInventoryRefetchInterval,
	mcpRuntimeHealthForDeployment,
	mcpRuntimeIsConvergedForDeployment,
} from "@/hosted/agents/hosted-agent-mcp";
import { unwrap, useApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";

type McpServer = components["schemas"]["AgentMcpServerInventoryItem"];
type RuntimeHealth = components["schemas"]["RuntimeObservedHealthResponse"];

export function HostedAgentMcpTab({
	environmentId,
	deploymentId,
	convergenceEvidenceAvailable,
	runtimeEvidenceFence,
}: {
	environmentId: string;
	deploymentId: string;
	convergenceEvidenceAvailable: boolean;
	runtimeEvidenceFence: string;
}) {
	const api = useApi();
	const addressable = agentMcpInventoryQueryEnabled(environmentId);
	const inventory = useQuery({
		queryKey: agentMcpInventoryQueryKey(environmentId, runtimeEvidenceFence),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}/mcp", {
					params: { path: { agent_id: environmentId } },
				}),
			),
		enabled: addressable,
		refetchInterval: (query) => agentMcpInventoryRefetchInterval(query.state.data, deploymentId),
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: true,
	});
	const runtimeObserved = useAgentRuntimeObserved(
		environmentId,
		addressable && convergenceEvidenceAvailable,
		runtimeEvidenceFence,
		(snapshot) => mcpRuntimeIsConvergedForDeployment(snapshot, deploymentId),
	);

	if (!addressable) {
		return (
			<div data-hosted="true">
				<EmptyState
					icon={Server}
					title="MCP inventory is unavailable"
					description="The deployment does not have an addressable Agent projection yet, so Clawdi cannot verify any user-declared MCP resources."
				/>
			</div>
		);
	}
	if (inventory.error) {
		if (isApiNotFoundError(inventory.error)) {
			return (
				<div data-hosted="true">
					<EmptyState
						icon={Server}
						title="MCP inventory is unavailable"
						description="The Agent projection is not present. User-declared MCP resources will appear only after Clawdi can verify their provenance."
					/>
				</div>
			);
		}
		return (
			<ApiErrorPanel
				error={inventory.error}
				onRetry={() => {
					void inventory.refetch();
				}}
				title="Couldn't load MCP inventory"
			/>
		);
	}
	if (inventory.isLoading) {
		return (
			<div data-hosted="true" className={HERO_GRID_CLASS}>
				{Array.from({ length: 3 }).map((_, index) => (
					<Skeleton key={index} className="h-28 rounded-xl" />
				))}
			</div>
		);
	}
	if (!inventory.data || !agentMcpInventoryMatchesDeployment(inventory.data, deploymentId)) {
		return (
			<div data-hosted="true">
				<EmptyState
					icon={Server}
					title="MCP inventory is unavailable"
					description="Clawdi cannot prove that this deployment's MCP declarations are user-managed, so no inventory rows are shown."
				/>
			</div>
		);
	}

	const servers = inventory.data.servers ?? [];
	const health =
		convergenceEvidenceAvailable && !runtimeObserved.isError
			? mcpRuntimeHealthForDeployment(runtimeObserved.data, deploymentId)
			: undefined;
	return (
		<div data-hosted="true" className="space-y-4">
			{servers.length > 0 ? <OverallMcpConvergence health={health} /> : null}
			{servers.length === 0 ? (
				<EmptyState
					icon={Server}
					title="No user-declared MCP servers"
					description="No MCP resources with proven user-declaration provenance are available. Clawdi's built-in MCP endpoint and connector tools are platform capabilities, so they are not inventory rows."
				/>
			) : (
				<div className={HERO_GRID_CLASS}>
					{servers.map((server) => (
						<McpServerCard key={server.id} server={server} />
					))}
				</div>
			)}
		</div>
	);
}

function OverallMcpConvergence({ health }: { health: RuntimeHealth | undefined }) {
	if (!health) {
		return (
			<Alert>
				<AlertTitle>Runtime convergence unavailable</AlertTitle>
				<AlertDescription>
					User-declared MCP servers are shown below. Runtime observation is unavailable while the
					Agent is stopped, creating, or not yet projected.
				</AlertDescription>
			</Alert>
		);
	}
	const label =
		health.status === "ok"
			? "Converged"
			: health.status === "stale"
				? "Observation stale"
				: health.status === "error"
					? "Drift or runtime error"
					: "Convergence unknown";
	return (
		<Alert>
			<AlertTitle>User MCP runtime status: {label}</AlertTitle>
			<AlertDescription>
				This overall status uses the Agent runtime health fence. Individual servers do not claim
				convergence.
			</AlertDescription>
		</Alert>
	);
}

function McpServerCard({ server }: { server: McpServer }) {
	return (
		<HeroCard
			className="min-h-28 gap-2"
			icon={
				<IconChip size="sm" tint="bg-identity-3-bg text-identity-3-fg" className="rounded-lg">
					<Server className="size-4" />
				</IconChip>
			}
			title={server.id}
			badges={
				<>
					<Badge variant="outline">{transportLabel(server.transport)}</Badge>
					<Badge variant={server.enabled ? "secondary" : "outline"}>
						{server.enabled ? "Enabled" : "Disabled"}
					</Badge>
				</>
			}
			description="User-declared MCP server"
			footer={[<span key="source">Explicit user declaration · Read-only</span>]}
		/>
	);
}

function transportLabel(transport: McpServer["transport"]): string {
	if (transport === "streamable-http") return "Streamable HTTP";
	if (transport === "sse") return "SSE";
	return "stdio";
}
