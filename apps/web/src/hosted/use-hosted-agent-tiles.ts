"use client";

import type { components } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { AgentTile } from "@/components/dashboard/agents-card";
import { deploymentDisplayName, hostedRuntimeTargetRouteId } from "@/hosted/agent-identity";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { billingQueryRetry, isNetworkError } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/hooks";
import { enabledDeploymentRuntimeTargets, runtimeTargetDisplayName } from "@/hosted/runtimes";
import { agentSectionHref } from "@/lib/agent-routes";

type Env = components["schemas"]["EnvironmentResponse"];

/**
 * Bridges hosted deploy API `Deployment` records to the unified `AgentTile`
 * shape rendered by `AgentsCard`. Hosted-side projection lives here so
 * `AgentsCard` itself never imports from `@/hosted/*`.
 *
 * `cloudEnvs` is the cloud-api environments list the parent already
 * fetches for the self-managed grid; passing it through lets each
 * hosted tile attach its matching `EnvironmentResponse` (joined via
 * `deployment.config_info.runtime_targets[agent_id].environment_id === env.id`).
 * With the join, the same `DaemonStatusBadge` that powers
 * self-managed tiles' "Synced 2m ago" label fires on hosted tiles too
 * — hosted runtimes register cloud-api envs with their own daemon, so
 * the data is the same shape; only the "Clawdi" pill distinguishes
 * hosted in the UI.
 */
export function useHostedAgentTiles({ cloudEnvs }: { cloudEnvs: Env[] }) {
	const client = useBillingClient();
	// Not configured (preview/self-hosted mirror pointing at the default
	// localhost deploy API) → don't fetch, don't error-banner. See
	// isDeployApiConfigured.
	const configured = isDeployApiConfigured();
	const query = useQuery<HostedDeployment[], Error>({
		queryKey: billingKeys.deployments,
		enabled: configured,
		queryFn: () => client.listDeployments(),
		retry: billingQueryRetry,
		// Status changes (Provisioning → Ready) — refetch periodically
		// while a deployment is still spinning up. 10s is the balance
		// between snappy feedback and avoiding excess deploy API load.
		refetchInterval: (q) => {
			const items = q.state.data ?? [];
			const transient = items.some((d) => isTransientStatus(d.status));
			return transient ? 10_000 : false;
		},
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
	const tiles = useMemo<AgentTile[]>(
		() => (query.data ?? []).flatMap((d) => deploymentToTiles(d, envById)),
		[query.data, envById],
	);

	// Env ids that are owned by a hosted deployment. The dashboard
	// excludes these from its self-managed grid so a hosted deployment's env
	// — which cloud-api also returns from /api/environments because
	// the admin endpoint registered it — doesn't double-count as both
	// a hosted tile and a self-managed tile. Lower-cased for the same
	// case-sensitivity defense as `envById`.
	const claimedEnvIds = useMemo(() => {
		const s = new Set<string>();
		for (const d of query.data ?? []) {
			for (const target of enabledDeploymentRuntimeTargets(d)) {
				if (target.environmentId) s.add(target.environmentId.toLowerCase());
			}
		}
		return s;
	}, [query.data]);

	// CORS/network-level failures (fetch throws TypeError before any HTTP
	// response is readable) mean this origin can't talk to the deploy API
	// at all. That is "hosted isn't available here," not an outage: stay
	// silent. Readable HTTP errors (5xx/4xx from an allowed origin) keep
	// the banner — those are real failures on hosts where the integration
	// genuinely works.
	const unreachableFromOrigin = isNetworkError(query.error);

	return {
		tiles,
		claimedEnvIds,
		// Disabled queries report isLoading=true forever in v5 (status
		// stays 'pending'); mask both flags when we never fetch.
		isLoading: configured ? query.isLoading : false,
		error: configured && !unreachableFromOrigin ? query.error : null,
	};
}

/**
 * One deployment fans out to one tile per enabled runtime target. Target ids are
 * the stable identity; runtime types only drive icon and adapter metadata.
 */
function deploymentToTiles(d: HostedDeployment, envById: Map<string, Env>): AgentTile[] {
	const targets = enabledDeploymentRuntimeTargets(d);
	const slug = deploymentDisplayName(d.name);
	const statusLabel = displayStatus(d.status);
	// Hosted deployments don't use last_seen_at; status is the freshness signal
	const active = d.status === "running" || d.status === "ready";
	return targets.map((target) => {
		// Hosted env join: each hosted runtime registers a cloud-api env
		// via the admin endpoint. Match by target environment_id
		// so the tile picks up daemon sync state (last_sync_at, queue
		// depth, status badge) from cloud-api, and the primary click
		// target points at the in-app env detail page — same UX as a
		// self-managed agent. Lifecycle ops (Restart/Stop/Delete) live
		// in that detail page's Settings section.
		//
		// If there is no registered env yet, route by explicit
		// deployment-target id so the detail page never guesses a sibling
		// runtime by type or list order.
		const envId = target.environmentId;
		const matchedEnv = envId ? envById.get(envId.toLowerCase()) : undefined;
		const routeId = matchedEnv?.id ?? hostedRuntimeTargetRouteId(d.id, target.id);
		const detailHref = matchedEnv
			? agentSectionHref(matchedEnv.id, "overview", "source=on-clawdi")
			: agentSectionHref(routeId, "overview", "source=on-clawdi");
		const settingsHref = matchedEnv
			? agentSectionHref(matchedEnv.id, "settings", "source=on-clawdi")
			: agentSectionHref(routeId, "settings", "source=on-clawdi");
		return {
			id: `${d.id}:${target.id}`,
			source: "on-clawdi" as const,
			name: matchedEnv?.display_name?.trim() || runtimeTargetDisplayName(target),
			displayName: matchedEnv?.display_name ?? null,
			avatarUrl: matchedEnv?.avatar_url ?? null,
			sortOrder: matchedEnv?.sort_order ?? null,
			agentType: target.type,
			// Deployment slug as the secondary line lets users disambiguate
			// when they have more than one hosted deployment. Mode info ("Daemon") is
			// implied by the "Clawdi" badge — every hosted runtime is daemon.
			runtimeLabel: slug,
			statusLabel,
			lastSeenAt: matchedEnv?.last_seen_at ?? null,
			// `?source=on-clawdi` is the breadcrumb the agent detail page
			// reads so its sync badge can mirror the hosted-aware copy
			// we render here. A user who bookmarks/shares this URL keeps
			// that intent; a self-managed user who happens to navigate
			// to the same env without the param defaults to the standard
			// self-managed badge.
			href: detailHref,
			external: false,
			manageHref: settingsHref,
			active,
			env: matchedEnv ?? null,
			// Group sibling runtime-agents under their shared compute on /agents.
			computeId: d.id,
			computeName: slug,
		};
	});
}

function displayStatus(status: string): string {
	if (status === "running" || status === "ready") return "Running";
	if (status === "pending") return "Pending";
	if (status === "provisioning") return "Provisioning…";
	if (status === "starting") return "Starting…";
	if (status === "failed" || status === "error") return "Failed";
	if (status === "stopped") return "Stopped";
	return status;
}

function isTransientStatus(status: string): boolean {
	return status === "pending" || status === "provisioning" || status === "starting";
}
