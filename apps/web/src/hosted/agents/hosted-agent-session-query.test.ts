import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	environmentManager,
	focusManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import {
	HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS,
	HOSTED_AGENT_SESSIONS_REFRESH_POLICY,
	shouldBlockHostedSessionsError,
} from "./hosted-agent-session-query";

const detailSource = readFileSync(new URL("./hosted-agent-detail.tsx", import.meta.url), "utf8");
const sharedSessionQuerySource = readFileSync(
	new URL("../../lib/session-queries.ts", import.meta.url),
	"utf8",
);

describe("hosted agent sessions refresh", () => {
	test("blocks initial errors but preserves stale data after a background error", () => {
		const error = new Error("background refresh failed");
		expect(shouldBlockHostedSessionsError(error, false)).toBe(true);
		expect(shouldBlockHostedSessionsError(error, true)).toBe(false);
		expect(shouldBlockHostedSessionsError(null, false)).toBe(false);
		expect(shouldBlockHostedSessionsError(undefined, true)).toBe(false);
	});

	test("polls only while an observer is mounted in the foreground", async () => {
		expect(HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS).toBe(30_000);
		expect(HOSTED_AGENT_SESSIONS_REFRESH_POLICY).toEqual({
			refetchInterval: 30_000,
			refetchIntervalInBackground: false,
		});

		environmentManager.setIsServer(() => false);
		focusManager.setFocused(false);
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		let calls = 0;
		const observer = new QueryObserver(queryClient, {
			queryKey: ["test", "hosted-sessions-foreground-refresh"],
			queryFn: async () => {
				calls += 1;
				return { items: [], total: 0 };
			},
			...HOSTED_AGENT_SESSIONS_REFRESH_POLICY,
			refetchInterval: 5,
		});
		const unsubscribe = observer.subscribe(() => undefined);
		let mounted = true;

		try {
			await Bun.sleep(20);
			expect(calls).toBe(1);

			focusManager.setFocused(true);
			for (let attempt = 0; attempt < 20 && calls === 1; attempt += 1) {
				await Bun.sleep(5);
			}
			expect(calls).toBeGreaterThan(1);

			unsubscribe();
			mounted = false;
			const callsAfterUnmount = calls;
			await Bun.sleep(20);
			expect(calls).toBe(callsAfterUnmount);
		} finally {
			if (mounted) unsubscribe();
			queryClient.clear();
			focusManager.setFocused(undefined);
			environmentManager.setIsServer(() => typeof window === "undefined");
		}
	});

	test("keeps refresh ownership and pagination local to the Sessions surface", () => {
		const componentStart = detailSource.indexOf("function HostedAgentSessionsTab(");
		const componentEnd = detailSource.indexOf("\nfunction ", componentStart + 1);
		const componentSource = detailSource.slice(componentStart, componentEnd);
		const parentComponentSource = detailSource.slice(
			detailSource.indexOf("export function HostedAgentDetail("),
			componentStart,
		);
		expect(componentSource).toContain("...HOSTED_AGENT_SESSIONS_REFRESH_POLICY");
		expect(parentComponentSource).not.toContain("...HOSTED_AGENT_SESSIONS_REFRESH_POLICY");
		expect(sharedSessionQuerySource).not.toContain("refetchInterval");
		expect(componentSource).toContain("placeholderData: keepPreviousData");
		expect(componentSource).toContain(
			"shouldBlockHostedSessionsError(sessions.error, sessions.data !== undefined)",
		);
		expect(componentSource).toContain("onRetry={() => sessions.refetch()}");
		expect(componentSource).toContain("page={page}");
		expect(componentSource).toContain("pageSize={pageSize}");
		expect(componentSource).toContain("onPageChange={setPage}");
		expect(componentSource).toContain("onPageSizeChange={(nextPageSize) =>");
	});

	test("mounts the polling query only in the active Sessions branch", () => {
		const sessionsBranchStart = detailSource.indexOf(
			'{deploymentStatus.known && activeTab === "sessions" ? (',
		);
		const sessionsBranchEnd = detailSource.indexOf(
			'{deploymentStatus.known && activeTab === "skills" ? (',
			sessionsBranchStart,
		);
		const sessionsBranch = detailSource.slice(sessionsBranchStart, sessionsBranchEnd);

		expect(sessionsBranchStart).toBeGreaterThan(-1);
		expect(sessionsBranchEnd).toBeGreaterThan(sessionsBranchStart);
		expect(sessionsBranch).toContain("<HostedAgentSessionsTab");
		expect(detailSource.match(/<HostedAgentSessionsTab/g) ?? []).toHaveLength(1);
	});
});
