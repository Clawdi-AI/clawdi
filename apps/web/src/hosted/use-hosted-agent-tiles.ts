"use client";

import type { components, Deployment } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { AgentTile } from "@/components/dashboard/agents-card";
import { unwrapClawdi, useClawdiApi } from "@/hosted/clawdi-api";
import { env } from "@/lib/env";

type Env = components["schemas"]["EnvironmentResponse"];

/**
 * Bridges clawdi.ai's `Deployment` to the unified `AgentTile`
 * shape rendered by `AgentsCard`. Hosted-side projection lives here so
 * `AgentsCard` itself never imports from `@/hosted/*`.
 *
 * `cloudEnvs` is the cloud-api environments list the parent already
 * fetches for the self-managed grid; passing it through lets each
 * hosted tile attach its matching `EnvironmentResponse` (joined via
 * `deployment.config_info.clawdi_cloud_environments[agent_type] ===
 * env.id`). With the join, the same `DaemonStatusBadge` that powers
 * self-managed tiles' "Synced 2m ago" label fires on hosted tiles too
 * — Phase 4a registers each hosted pod as a cloud-api env with its
 * own daemon, so the data is the same shape; only the "Clawdi" pill
 * + external management URL distinguish hosted in the UI.
 */
export function useHostedAgentTiles({
	enabled,
	cloudEnvs,
}: {
	enabled: boolean;
	cloudEnvs: Env[];
}) {
	const api = useClawdiApi();
	const query = useQuery({
		queryKey: ["hosted-deployments"],
		queryFn: async () => unwrapClawdi(await api.GET("/deployments")),
		enabled,
		// Status changes (Provisioning → Ready) — refetch periodically
		// while a deployment is still spinning up. 10s is the balance
		// between snappy feedback and not hammering clawdi.ai.
		refetchInterval: (q) => {
			const items = q.state.data ?? [];
			const transient = items.some((d) => isTransientStatus(d.status));
			return transient ? 10_000 : false;
		},
	});

	// Memoize the env-by-id index so the tile join is O(N+M) instead
	// of O(N×M) on every render of the hosted-agent grid.
	const envById = useMemo(() => {
		const m = new Map<string, Env>();
		for (const e of cloudEnvs) m.set(e.id, e);
		return m;
	}, [cloudEnvs]);

	const tiles: AgentTile[] = (query.data ?? []).flatMap((d) => deploymentToTiles(d, envById));

	// Env ids that are owned by a hosted deployment. The dashboard
	// excludes these from its self-managed grid so a hosted pod's env
	// — which cloud-api also returns from /api/environments because
	// the admin endpoint registered it — doesn't double-count as both
	// a hosted tile and a self-managed tile.
	const claimedEnvIds = new Set<string>();
	for (const d of query.data ?? []) {
		for (const envId of Object.values(d.config_info?.clawdi_cloud_environments ?? {})) {
			if (envId) claimedEnvIds.add(envId);
		}
	}

	return {
		tiles,
		claimedEnvIds,
		isLoading: query.isLoading,
		error: query.error,
	};
}

const KNOWN_RUNTIMES = ["openclaw", "hermes"] as const;
type Runtime = (typeof KNOWN_RUNTIMES)[number];

function isKnownRuntime(s: string): s is Runtime {
	return (KNOWN_RUNTIMES as readonly string[]).includes(s);
}

/**
 * One deployment fans out to one tile per onboarded runtime. OpenClaw
 * (:18789) and Hermes (:18793) are completely separate dashboard
 * surfaces in clawdi.ai — different web servers, capability
 * sets, management URLs — so the unified grid renders them as
 * distinct agents.
 *
 * `onboarded_agents` is the source of truth: backend writes
 * `["hermes"]` or `["openclaw"]` at deploy time
 * (backend/app/routes/deployments.py:705,1122 — they're mutually
 * exclusive at provision), and grows the array via
 * `/deployments/{id}/onboard-agent` when a user later adds a second
 * runtime. We trust the array literally — never synthesize a runtime
 * that isn't in it (the pod doesn't have that process).
 */
function deploymentToTiles(d: Deployment, envById: Map<string, Env>): AgentTile[] {
	const runtimes = resolveRuntimes(d);
	const slug = deploymentSlug(d);
	const statusLabel = displayStatus(d.status);
	// Hosted deployments don't use last_seen_at; status is the freshness signal
	const active = d.status === "running" || d.status === "ready";
	const cloudEnvIds = d.config_info?.clawdi_cloud_environments ?? {};
	return runtimes.map((runtime) => {
		// Phase 4a join: each hosted pod registers a cloud-api env per
		// agent_type via the admin endpoint. Match by agent_type →
		// environment_id so the tile picks up daemon sync state
		// (last_sync_at, queue depth, status badge) from cloud-api,
		// AND the primary click target points at the in-app env detail
		// page — same UX as a self-managed agent. Lifecycle ops
		// (Restart/Stop/Delete) live on the SaaS dashboard, surfaced
		// via the secondary `manageHref` button on the tile.
		//
		// Missing match (legacy pre-Phase-4a deployment, mint failed,
		// or `CLAWDI_CLOUD_LIVE_SYNC_ENABLED=false`) → fall back to the
		// SaaS dashboard URL as the primary, so the tile still has a
		// useful place to click.
		const envId = cloudEnvIds[runtime];
		const matchedEnv = envId ? envById.get(envId) : undefined;
		const manageUrl = deploymentManageUrl(d, runtime);
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
			href: matchedEnv ? `/agents/${matchedEnv.id}` : manageUrl,
			external: !matchedEnv,
			manageHref: manageUrl,
			active,
			env: matchedEnv ?? null,
		};
	});
}

function resolveRuntimes(d: Deployment): Runtime[] {
	// Trust `onboarded_agents` — it reflects the actual processes the
	// backend provisioned. A Hermes-only pod has no OpenClaw daemon
	// listening on :18789, so showing an OpenClaw tile would dead-link.
	const set = new Set<Runtime>();
	for (const r of d.config_info?.onboarded_agents ?? []) {
		if (isKnownRuntime(r)) set.add(r);
	}
	if (set.size > 0) return Array.from(set);
	// Older deployments may have populated only `enable_hermes` without
	// the `onboarded_agents` array. Fall back to the same mutual
	// exclusion the backend uses (deployments.py:705).
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

/**
 * Strip clawdi.ai's auto-generated `openclaw-` / `hermes-` prefix
 * from a deployment name. The prefix is an app-slug artifact (every
 * pod gets it regardless of which runtimes are active), so it reads
 * as misleading runtime metadata on a tile for the *other* runtime.
 * If the user gave their deployment a real name, no prefix matches
 * and we keep it intact.
 */
function deploymentSlug(d: Deployment): string {
	const stripped = d.name.replace(/^(openclaw|hermes)-/i, "");
	return stripped || d.name;
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

/**
 * Deep-link into clawdi.ai/dashboard for one (deployment, runtime).
 * Pairs with clawdi.ai's `useAgentTypeStore` which hydrates from
 * `?agent_type=` so the sidebar dropdown matches the tile clicked.
 * Override the base via `NEXT_PUBLIC_DEPLOY_DASHBOARD_URL`.
 */
function deploymentManageUrl(deployment: Deployment, runtime?: string): string {
	const url = new URL(env.NEXT_PUBLIC_DEPLOY_DASHBOARD_URL);
	url.searchParams.set("deployment", deployment.id);
	if (runtime === "openclaw" || runtime === "hermes") {
		url.searchParams.set("agent_type", runtime);
	}
	return url.toString();
}
