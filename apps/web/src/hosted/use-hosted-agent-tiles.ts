"use client";

import type { components } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { AgentTile } from "@/components/dashboard/agents-card";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { billingQueryRetry, isNetworkError } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/hooks";

type Env = components["schemas"]["EnvironmentResponse"];

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
	// excludes these from its self-managed grid so a hosted pod's env
	// — which cloud-api also returns from /api/environments because
	// the admin endpoint registered it — doesn't double-count as both
	// a hosted tile and a self-managed tile. Lower-cased for the same
	// case-sensitivity defense as `envById`.
	const claimedEnvIds = useMemo(() => {
		const s = new Set<string>();
		for (const d of query.data ?? []) {
			for (const envId of Object.values(d.config_info?.clawdi_cloud_environments ?? {})) {
				if (envId) s.add(envId.toLowerCase());
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

const KNOWN_RUNTIMES = ["openclaw", "hermes"] as const;
type Runtime = (typeof KNOWN_RUNTIMES)[number];

function isKnownRuntime(s: string): s is Runtime {
	return (KNOWN_RUNTIMES as readonly string[]).includes(s);
}

/**
 * One deployment fans out to one tile per running runtime. OpenClaw
 * (:18789) and Hermes (:9119) are completely separate dashboard
 * surfaces in the hosted dashboard — different web servers and
 * capability sets — so the unified grid renders them as distinct agents.
 *
 * Runtime resolution priority (see `resolveRuntimes` below):
 *   1. `clawdi_cloud_environments` keys. Each key corresponds to a
 *      runtime with a live cloud-api env binding.
 *   2. `onboarded_agents`, when it names recognizable runtimes.
 *   3. `enable_hermes`, for deployments that expose only that field.
 *
 * We never synthesize a runtime that isn't surfaced by one of these
 * sources (the pod doesn't have that process running).
 */
function deploymentToTiles(d: HostedDeployment, envById: Map<string, Env>): AgentTile[] {
	const runtimes = resolveRuntimes(d);
	const slug = deploymentDisplayName(d.name);
	const statusLabel = displayStatus(d.status);
	// Hosted deployments don't use last_seen_at; status is the freshness signal
	const active = d.status === "running" || d.status === "ready";
	const cloudEnvIds = d.config_info?.clawdi_cloud_environments ?? {};
	return runtimes.map((runtime) => {
		// Hosted env join: each hosted runtime registers a cloud-api env
		// via the admin endpoint. Match by agent_type → environment_id
		// so the tile picks up daemon sync state (last_sync_at, queue
		// depth, status badge) from cloud-api, and the primary click
		// target points at the in-app env detail page — same UX as a
		// self-managed agent. Lifecycle ops (Restart/Stop/Delete) live
		// in that detail page's Compute tab.
		//
		// If there is no registered env yet, route by deployment id.
		// `AgentHome` resolves deployment ids without pretending they are
		// cloud-api environment ids, so the tile still has a useful
		// in-app place to click.
		const envId = cloudEnvIds[runtime];
		const matchedEnv = envId ? envById.get(envId.toLowerCase()) : undefined;
		const detailHref = matchedEnv ? `/agents/${matchedEnv.id}?source=on-clawdi` : `/agents/${d.id}`;
		const computeHref = `${detailHref}${detailHref.includes("?") ? "&" : "?"}tab=compute`;
		return {
			id: `${d.id}:${runtime}`,
			source: "on-clawdi" as const,
			// Runtime is the primary identifier on hosted tiles since the
			// AgentIcon already brands it and one deployment fans out to
			// multiple tiles — using `d.name` here would print
			// "openclaw-b5451f9c" on a Hermes tile.
			name: runtimeDisplayName(runtime),
			agentType: runtime,
			// Deployment slug as the secondary line lets users disambiguate
			// when they have more than one pod. Mode info ("Daemon") is
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
			manageHref: computeHref,
			active,
			env: matchedEnv ?? null,
			// Group sibling runtime-agents under their shared compute on /agents.
			computeId: d.id,
			computeName: slug,
		};
	});
}

function resolveRuntimes(d: HostedDeployment): Runtime[] {
	// `clawdi_cloud_environments` is the authoritative source: every
	// agent with a live-sync env on cloud-api is by definition a daemon
	// running in the pod. If it's there, it's real.
	const set = new Set<Runtime>();
	for (const r of Object.keys(d.config_info?.clawdi_cloud_environments ?? {})) {
		if (isKnownRuntime(r)) set.add(r);
	}
	// `onboarded_agents` is the next source: trust it only when it names
	// recognizable runtimes. Empty arrays and arrays full of unknown
	// strings mean the field is not authoritative, not that the
	// deployment has zero running agents.
	for (const r of d.config_info?.onboarded_agents ?? []) {
		if (isKnownRuntime(r)) set.add(r);
	}
	if (set.size > 0) return Array.from(set);
	// Final compatibility source for deployments that only expose
	// `enable_hermes`.
	return [d.config_info?.enable_hermes ? "hermes" : "openclaw"];
}

function runtimeDisplayName(runtime: Runtime): string {
	switch (runtime) {
		case "openclaw":
			return "OpenClaw";
		case "hermes":
			return "Hermes";
	}
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
