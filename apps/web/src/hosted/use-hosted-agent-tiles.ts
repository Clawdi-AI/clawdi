"use client";

import type { components } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { createElement, type ReactNode, useMemo } from "react";
import { agentDisplayName } from "@/components/dashboard/agent-label";
import {
	type AgentFleetSummary,
	type AgentTile,
	fleetSummaryFromTiles,
	isAgentActive,
} from "@/components/dashboard/agents-card";
import {
	DaemonStatusBadge,
	type DaemonStatusVisual,
	daemonStatusVisual,
} from "@/components/dashboard/daemon-status";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import { computeDunningTileStatus } from "@/hosted/billing/components/compute-dunning.logic";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { billingQueryRetry, isNetworkError } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/hooks";
import { hasExistingCloudDeployments } from "@/hosted/cloud-deployment-management";
import {
	type DeploymentStatus,
	type DeploymentStatusTone,
	deploymentStatusLabel,
	deploymentStatusTone,
	isRunningStatus,
	parseDeploymentStatus,
	shouldPollDeployments,
} from "@/hosted/deployment-status";
import { legacyConnectedAgentTiles } from "@/hosted/legacy-agent-tiles";
import { deploymentRuntime, runtimeDisplayName, runtimeEnvironmentId } from "@/hosted/runtimes";
import { normalizeAgentEnvId, useAgentOwnership } from "@/lib/agent-ownership";
import { agentSectionHref } from "@/lib/agent-routes";

type Env = components["schemas"]["AgentResponse"];
type DeploymentStatusInput = Pick<HostedDeployment, "status">;

const EMPTY_ENV_IDS: ReadonlySet<string> = new Set();

const COMPUTE_DOT_TONE: Record<DeploymentStatusTone, string> = {
	success: "bg-success ring-2 ring-success/20",
	warning: "bg-warning ring-2 ring-warning/20",
	destructive: "bg-destructive ring-2 ring-destructive/20",
	info: "bg-info ring-2 ring-info/20",
	neutral: "border border-muted-foreground/50 bg-transparent",
};

const COMPUTE_TEXT_TONE: Record<DeploymentStatusTone, string> = {
	success: "text-muted-foreground",
	warning: "text-warning-muted-foreground font-medium",
	destructive: "text-destructive-muted-foreground font-medium",
	info: "text-info-muted-foreground",
	neutral: "text-muted-foreground",
};

export interface HostedRuntimeStatusView {
	compute: DeploymentStatus;
	sync: DaemonStatusVisual | null;
	primary: {
		label: string;
		dotClass: string;
		textClass: string;
	};
	secondary: {
		kind: DaemonStatusVisual["kind"];
		label: string;
		tooltip: string;
		textClass: string;
	} | null;
	active: boolean;
}

export function hostedRuntimeStatusView(
	deployment: DeploymentStatusInput,
	env: Env | null | undefined,
): HostedRuntimeStatusView {
	const compute = parseDeploymentStatus(deployment.status);
	const computeLabel = deploymentStatusLabel(compute);
	const computeTone = deploymentStatusTone(compute);
	const sync = env === undefined ? null : daemonStatusVisual(env, "on-clawdi");
	const computeIsRunning = isRunningStatus(compute);
	const envIsFresh = isAgentActive(env?.last_seen_at);
	const secondary =
		computeIsRunning && sync && sync.kind !== "live"
			? {
					kind: sync.kind,
					label: sync.badgeLabel,
					tooltip: sync.tooltip,
					textClass: sync.textClass,
				}
			: null;

	return {
		compute,
		sync,
		primary: {
			label: computeLabel,
			dotClass: COMPUTE_DOT_TONE[computeTone],
			textClass: COMPUTE_TEXT_TONE[computeTone],
		},
		secondary,
		active: computeIsRunning || envIsFresh,
	};
}

/**
 * Env ids claimed by Cloud deploy-API deployments (lower-cased —
 * see the case note on `envById`). Shared by the tile dedup here and
 * the sidebar's cloud-vs-legacy chrome classification so the two can
 * never disagree about which externally managed env is a Cloud agent.
 */
export function claimedEnvIdsFromDeployments(
	deployments: readonly HostedDeployment[],
): Set<string> {
	const s = new Set<string>();
	for (const d of deployments) {
		const envId = runtimeEnvironmentId(d.config_info);
		if (envId) s.add(envId.toLowerCase());
	}
	return s;
}

/**
 * Bridges hosted deploy API `Deployment` records to the unified `AgentTile`
 * shape rendered by `AgentsCard`. Hosted-side projection lives here so
 * `AgentsCard` itself never imports from `@/hosted/*`.
 *
 * `cloudEnvs` is the cloud-api environments list the parent already
 * fetches for the self-managed grid; passing it through lets each
 * hosted tile attach its matching `EnvironmentResponse` (joined via
 * `deployment.config_info.clawdi_cloud_environments[agent_type] ===
 * env.id`). With the join, the same `DaemonStatusBadge` that powers
 * self-managed tiles' "Synced 2m ago" label fires on hosted tiles too
 * — hosted runtimes register cloud-api envs with their own daemon, so
 * the data is the same shape; only the "Clawdi" pill distinguishes
 * hosted in the UI.
 */
export function useHostedAgentTiles({
	cloudEnvs,
	includeDeployments = true,
}: {
	cloudEnvs: Env[];
	includeDeployments?: boolean;
}) {
	const client = useBillingClient();
	// Not configured (preview/self-hosted mirror pointing at the default
	// localhost deploy API) → don't fetch, don't error-banner. See
	// isDeployApiConfigured.
	const configured = isDeployApiConfigured();
	const query = useQuery<HostedDeployment[], Error>({
		queryKey: billingKeys.deployments,
		enabled: configured && includeDeployments,
		queryFn: () => client.listDeployments(),
		retry: billingQueryRetry,
		// Poll while deployments are unsettled. The deploy API status is a string,
		// so unknown future states are treated as non-terminal until a settled
		// state arrives.
		refetchInterval: (q) => (shouldPollDeployments(q.state.data) ? 10_000 : false),
	});

	// Memoize the env-by-id index so the tile join is O(N+M) instead
	// of O(N×M) on every render of the hosted-agent grid.
	//
	// Both index keys and lookup keys are forced lowercase. PostgreSQL
	// stores UUIDs case-insensitively by convention but emits them
	// lowercase via asyncpg; the deploy API could in principle hand us
	// mixed case at the rim. Comparing as-stored would silently miss a
	// real match, leaving both a hosted tile and a self-managed tile
	// for the same env. Normalize at the boundary, not the comparison site.
	const envById = useMemo(() => {
		const m = new Map<string, Env>();
		for (const e of cloudEnvs) m.set(e.id.toLowerCase(), e);
		return m;
	}, [cloudEnvs]);

	// Both `tiles` and `claimedEnvIds` derive from `query.data`. Memoize
	// them so refetchInterval (10s for transient deployments) doesn't
	// rebuild N×M JSX trees on every poll when nothing actually changed.
	// TanStack Query gives the same `data` reference back on no-op
	// refetches, so the memo deps stay stable.
	const tiles = useMemo<AgentTile[]>(() => {
		return includeDeployments
			? (query.data ?? []).flatMap((d) => deploymentToTiles(d, envById))
			: [];
	}, [includeDeployments, query.data, envById]);

	// Env ids that are owned by a hosted deployment. The dashboard
	// excludes these from its self-managed grid so a hosted deployment's env
	// — which cloud-api also returns from /v1/agents because
	// the admin endpoint registered it — doesn't double-count as both
	// a hosted tile and a self-managed tile. Lower-cased for the same
	// case-sensitivity defense as `envById`.
	const claimedEnvIds = useMemo(() => {
		if (!includeDeployments) return new Set<string>();
		return claimedEnvIdsFromDeployments(query.data ?? []);
	}, [includeDeployments, query.data]);

	// CORS/network-level failures (fetch throws TypeError before any HTTP
	// response is readable) mean this origin can't talk to the deploy API
	// at all. That is "hosted isn't available here," not an outage: stay
	// silent. Readable HTTP errors (5xx/4xx from an allowed origin) keep
	// the banner — those are real failures on hosts where the integration
	// genuinely works.
	const unreachableFromOrigin = isNetworkError(query.error);

	return {
		hasExistingDeployments: includeDeployments && hasExistingCloudDeployments(query.data),
		tiles,
		claimedEnvIds,
		// Disabled queries report isLoading=true forever in v5 (status
		// stays 'pending'); mask both flags when we never fetch.
		isLoading: configured && includeDeployments ? query.isLoading : false,
		error: configured && includeDeployments && !unreachableFromOrigin ? query.error : null,
		refetch: query.refetch,
	};
}

/**
 * One deployment renders as one hosted agent tile. The selected runtime decides
 * which cloud-api environment is joined for daemon sync state and detail links.
 */
export function deploymentToTiles(d: HostedDeployment, envById: Map<string, Env>): AgentTile[] {
	const runtime = deploymentRuntime(d);
	const slug = deploymentDisplayName(d.name);
	// Hosted deployments don't use last_seen_at; status is the freshness signal
	// Hosted env join: the selected hosted runtime registers one cloud-api env
	// via the admin endpoint. If it is not minted yet, route by deployment id.
	const envId = runtimeEnvironmentId(d.config_info, runtime);
	const matchedEnv = envId ? envById.get(envId.toLowerCase()) : undefined;
	const detailHref = matchedEnv
		? agentSectionHref(matchedEnv.id, "overview", "source=on-clawdi")
		: agentSectionHref(d.id);
	const settingsHref = matchedEnv
		? agentSectionHref(matchedEnv.id, "settings", "source=on-clawdi")
		: agentSectionHref(d.id, "settings");
	const name = matchedEnv ? agentDisplayName(matchedEnv) : runtimeDisplayName(runtime);
	const contextLabel = slug !== name ? slug : null;
	const runtimeStatus = hostedRuntimeStatusView(d, matchedEnv ?? null);
	const dunningStatus = computeDunningTileStatus(d);
	return [
		{
			id: d.id,
			source: "on-clawdi" as const,
			name,
			avatarUrl: matchedEnv?.avatar_url ?? null,
			sortOrder: matchedEnv?.sort_order ?? null,
			agentType: runtime,
			contextLabel,
			statusLabel: runtimeStatus.primary.label,
			lastSeenAt: matchedEnv?.last_seen_at ?? null,
			href: detailHref,
			external: false,
			manageHref: settingsHref,
			active: runtimeStatus.active,
			statusDot: {
				label: runtimeStatus.primary.label,
				dotClass: runtimeStatus.primary.dotClass,
			},
			secondaryStatus: dunningStatus
				? dunningStatus
				: runtimeStatus.secondary
					? {
							label: runtimeStatus.secondary.label,
							title: runtimeStatus.secondary.tooltip,
							textClass: runtimeStatus.secondary.textClass,
						}
					: null,
			env: matchedEnv ?? null,
		},
	];
}

export function hostedAgentTileStatus(rawStatus: string): { label: string; active: boolean } {
	const status = parseDeploymentStatus(rawStatus);
	return {
		label: deploymentStatusLabel(status),
		active: isRunningStatus(status),
	};
}

export function unifiedHostedAgentTiles({
	selfManagedTiles,
	hostedTiles,
	claimedEnvIds,
	legacyEnvIds,
	cloudEnvs,
	showLegacyAgents,
}: {
	selfManagedTiles: AgentTile[];
	hostedTiles: AgentTile[];
	claimedEnvIds: ReadonlySet<string>;
	legacyEnvIds: ReadonlySet<string>;
	cloudEnvs: Env[];
	showLegacyAgents: boolean;
}): AgentTile[] {
	const legacyConnectedTiles = showLegacyAgents
		? legacyConnectedAgentTiles(cloudEnvs, legacyEnvIds, claimedEnvIds)
		: [];
	const dedupedSelfManaged = selfManagedTiles.filter(
		(tile) =>
			!isOwnedEnvId(tile.id, claimedEnvIds, showLegacyAgents ? legacyEnvIds : EMPTY_ENV_IDS),
	);
	return [...hostedTiles, ...legacyConnectedTiles, ...dedupedSelfManaged];
}

function isOwnedEnvId(
	id: string,
	claimedEnvIds: ReadonlySet<string>,
	legacyEnvIds: ReadonlySet<string>,
): boolean {
	const envId = normalizeAgentEnvId(id);
	return Boolean(envId && (claimedEnvIds.has(envId) || legacyEnvIds.has(envId)));
}

export function HostedFleetSummary({
	selfManagedTiles,
	cloudEnvs,
	showCloudDeployments = true,
	showLegacyAgents = false,
	children,
}: {
	selfManagedTiles: AgentTile[];
	cloudEnvs: Env[];
	showCloudDeployments?: boolean;
	showLegacyAgents?: boolean;
	children: (summary: AgentFleetSummary) => ReactNode;
}) {
	const hosted = useHostedAgentTiles({
		cloudEnvs,
		includeDeployments: showCloudDeployments,
	});
	const ownership = useAgentOwnership();
	const legacyEnvIds = showLegacyAgents ? ownership?.legacyEnvIds : EMPTY_ENV_IDS;
	const ownershipLoading =
		(showCloudDeployments && hosted.isLoading) || (showLegacyAgents && ownership === null);
	const tiles = useMemo(() => {
		if (ownershipLoading || !legacyEnvIds) return selfManagedTiles;
		return unifiedHostedAgentTiles({
			selfManagedTiles,
			hostedTiles: hosted.tiles,
			claimedEnvIds: hosted.claimedEnvIds,
			legacyEnvIds,
			cloudEnvs,
			showLegacyAgents,
		});
	}, [
		cloudEnvs,
		hosted.claimedEnvIds,
		hosted.tiles,
		legacyEnvIds,
		ownershipLoading,
		selfManagedTiles,
		showLegacyAgents,
	]);
	const summary = useMemo(() => fleetSummaryFromTiles(tiles), [tiles]);
	return children(summary);
}

export function HostedFocusRuntimeStatusBadge({
	env,
	manageHref,
	compact = false,
	tooltipDetail,
}: {
	env: Env;
	manageHref?: string;
	compact?: boolean;
	tooltipDetail?: string;
}) {
	const hosted = useHostedAgentTiles({ cloudEnvs: [env] });
	const envId = normalizeAgentEnvId(env.id);
	const tile = hosted.tiles.find((item) => normalizeAgentEnvId(item.env?.id) === envId);
	if (!tile?.statusDot) {
		if (hosted.isLoading) return createLoadingStatus(compact);
		return createElement(DaemonStatusBadge, {
			env,
			source: "on-clawdi",
			manageHref,
			compact,
			tooltipDetail,
		});
	}

	return createElement(
		"span",
		{
			className: "inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground",
			title: tile.secondaryStatus?.title ?? tile.statusDot.label,
		},
		createElement("span", {
			key: "dot",
			"aria-hidden": true,
			className: `inline-block size-1.5 shrink-0 rounded-full ${tile.statusDot.dotClass}`,
		}),
		createElement(
			"span",
			{
				key: "primary",
				className: "whitespace-nowrap",
			},
			tile.statusDot.label,
		),
		createSecondarySyncStatus({
			key: "secondary",
			tile,
			env,
			manageHref,
			tooltipDetail,
		}),
	);
}

function createLoadingStatus(compact: boolean) {
	return createElement(
		"span",
		{
			className: "inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground",
		},
		createElement("span", {
			key: "dot",
			"aria-hidden": true,
			className:
				"inline-block size-1.5 rounded-full border border-muted-foreground/50 bg-transparent",
		}),
		createElement("span", { key: "label" }, compact ? "Loading" : "Loading status"),
	);
}

function createSecondarySyncStatus({
	key,
	tile,
	env,
	manageHref,
	tooltipDetail,
}: {
	key: string;
	tile: AgentTile;
	env: Env;
	manageHref?: string;
	tooltipDetail?: string;
}) {
	if (!tile.secondaryStatus) return null;
	const label = tile.secondaryStatus.label;
	return createElement(
		"span",
		{
			key,
			className: "inline-flex min-w-0 items-center gap-1.5",
		},
		createElement(
			"span",
			{
				key: "separator",
				className: "text-muted-foreground/70",
				"aria-hidden": true,
			},
			"·",
		),
		tile.env
			? createElement(DaemonStatusBadge, {
					key: "badge",
					env,
					source: "on-clawdi",
					manageHref,
					tooltipDetail,
					showDot: false,
					labelOverride: label,
				})
			: createElement(
					"span",
					{
						key: "text",
						className: tile.secondaryStatus.textClass ?? "text-muted-foreground",
					},
					label,
				),
	);
}
