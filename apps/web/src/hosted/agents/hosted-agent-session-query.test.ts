import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS,
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

	test("uses a low-frequency foreground refresh", () => {
		expect(HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS).toBe(30_000);

		const componentStart = detailSource.indexOf("function HostedAgentSessionsTab(");
		const componentEnd = detailSource.indexOf("\nfunction ", componentStart + 1);
		const componentSource = detailSource.slice(componentStart, componentEnd);
		const parentComponentSource = detailSource.slice(
			detailSource.indexOf("export function HostedAgentDetail("),
			componentStart,
		);
		expect(componentSource).toContain("refetchInterval: HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS");
		expect(componentSource).toContain("refetchIntervalInBackground: false");
		expect(parentComponentSource).not.toContain(
			"refetchInterval: HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS",
		);
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
