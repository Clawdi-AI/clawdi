"use client";

import type { Deployment } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import type { AgentTile } from "@/components/dashboard/agents-card";
import { unwrapClawdi, useClawdiApi } from "@/hosted/clawdi-api";
import { env } from "@/lib/env";

/**
 * Bridges clawdi.ai's `Deployment` to the unified `AgentTile`
 * shape rendered by `AgentsCard`. Hosted-side projection lives here so
 * `AgentsCard` itself never imports from `@/hosted/*`.
 */
export function useHostedAgentTiles({ enabled }: { enabled: boolean }) {
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

	const tiles: AgentTile[] = (query.data ?? []).flatMap(deploymentToTiles);
	return {
		tiles,
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
function deploymentToTiles(d: Deployment): AgentTile[] {
	const runtimes = resolveRuntimes(d);
	const slug = deploymentSlug(d);
	const statusLabel = displayStatus(d.status);
	// Hosted deployments don't use last_seen_at; status is the freshness signal
	const active = d.status === "running" || d.status === "ready";
	return runtimes.map((runtime) => ({
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
		href: deploymentManageUrl(d, runtime),
		external: true,
		active,
	}));
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
