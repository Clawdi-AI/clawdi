import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	environmentManager,
	focusManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import {
	agentRuntimeObservedQueryKey,
	agentRuntimeObservedRefetchInterval,
	RUNTIME_OBSERVED_PENDING_REFETCH_INTERVAL_MS,
	RUNTIME_OBSERVED_SETTLED_REFETCH_INTERVAL_MS,
} from "@/hooks/agent-runtime-observed-query";

describe("deployment-managed MCP inventory", () => {
	test("removes the coarse Overview boolean in favor of the independent MCP page", () => {
		const overview = readFileSync(
			new URL("../hosted/agents/hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		expect(overview).not.toContain('label="Deployment MCP"');
		expect(overview).toContain("HostedAgentMcpTab");
		expect(overview).toContain('activeTab === "mcp"');
		expect(overview).not.toMatch(/mcp_server|managed_resources/);
	});

	test("refreshes stale runtime health and desired Skills under the same deployment fence", async () => {
		environmentManager.setIsServer(() => false);
		focusManager.setFocused(true);
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const snapshots = [
			{ health: { status: "stale" }, desired: { enabled: false } },
			{ health: { status: "ok" }, desired: { enabled: false } },
			{ health: { status: "ok" }, desired: { enabled: true } },
		] as const;
		const isConverged = (snapshot: (typeof snapshots)[number]) =>
			snapshot.health.status === "ok" && snapshot.desired.enabled;
		let calls = 0;
		const observer = new QueryObserver(queryClient, {
			queryKey: agentRuntimeObservedQueryKey("agent-1", "rv-same", true),
			queryFn: async () => {
				const snapshot = snapshots[Math.min(calls, snapshots.length - 1)];
				calls += 1;
				return snapshot;
			},
			refetchInterval: (query) =>
				agentRuntimeObservedRefetchInterval(query.state.data, isConverged) ===
				RUNTIME_OBSERVED_PENDING_REFETCH_INTERVAL_MS
					? 5
					: false,
			refetchIntervalInBackground: false,
		});
		const unsubscribe = observer.subscribe(() => undefined);

		try {
			for (
				let attempt = 0;
				attempt < 30 && !observer.getCurrentResult().data?.desired.enabled;
				attempt += 1
			) {
				await Bun.sleep(5);
			}
			expect(calls).toBeGreaterThanOrEqual(3);
			expect(observer.getCurrentResult().data).toEqual(snapshots[2]);
			expect(agentRuntimeObservedRefetchInterval(snapshots[2], isConverged)).toBe(
				RUNTIME_OBSERVED_SETTLED_REFETCH_INTERVAL_MS,
			);
		} finally {
			unsubscribe();
			queryClient.clear();
			focusManager.setFocused(undefined);
			environmentManager.setIsServer(() => typeof window === "undefined");
		}
	});

	test("partitions runtime cache across disabled, foreign, and missing identities", () => {
		const queryClient = new QueryClient();
		const activeKey = agentRuntimeObservedQueryKey("agent-1", "rv-1", true);
		queryClient.setQueryData<{ health: { status: string } }>(activeKey, {
			health: { status: "ok" },
		});

		expect(
			queryClient.getQueryData(agentRuntimeObservedQueryKey("agent-1", "rv-1", false)),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(agentRuntimeObservedQueryKey("agent-2", "rv-1", true)),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(agentRuntimeObservedQueryKey("agent-1", "rv-missing", true)),
		).toBeUndefined();
	});
});
