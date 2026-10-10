import { describe, expect, test } from "bun:test";
import { ApiClientError, ApiClientNetworkError } from "@clawdi/shared/api";
import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { transientQueryRetry } from "@/lib/query-retry";
import { AccountScopeChangedError } from "@/platform/auth/account-scope";

/** Hosted answers concurrent first-sign-in reads with this retryable problem. */
const busy = () => new ApiClientError(503, "request_temporarily_busy", 0);

async function settle(failures: unknown[]) {
	const client = new QueryClient();
	let calls = 0;
	const observer = new QueryObserver(client, {
		queryKey: ["availability"],
		queryFn: async () => {
			const failure = failures[calls++];
			if (failure) throw failure;
			return "available";
		},
		...transientQueryRetry,
	});
	const statuses: string[] = [];
	const result = await new Promise<{ status: string; error: unknown }>((resolve) => {
		const unsubscribe = observer.subscribe((next) => {
			statuses.push(next.status);
			if (next.status !== "pending") {
				unsubscribe();
				resolve(next);
			}
		});
	});
	client.clear();
	return { ...result, calls, statuses };
}

describe("transientQueryRetry", () => {
	test("a busy hosted read resolves without ever surfacing an error", async () => {
		const result = await settle([busy(), busy()]);
		expect(result.status).toBe("success");
		expect(result.calls).toBe(3);
		expect(result.statuses).not.toContain("error");
	});

	test("a persistent outage still becomes a definitive error", async () => {
		const result = await settle([busy(), busy(), busy(), busy()]);
		expect(result.status).toBe("error");
		expect(result.calls).toBe(3);
	});

	test("deterministic rejections and account fences are not retried", async () => {
		for (const failure of [new ApiClientError(403), new AccountScopeChangedError()]) {
			const result = await settle([failure]);
			expect(result.status).toBe("error");
			expect(result.calls).toBe(1);
		}
	});

	test("paginated reads such as Subscriptions ride out a busy reply too", async () => {
		const client = new QueryClient();
		let calls = 0;
		const observer = new InfiniteQueryObserver(client, {
			queryKey: ["subscriptions"],
			initialPageParam: undefined as string | undefined,
			queryFn: async () => {
				if (calls++ === 0) throw busy();
				return { items: ["sub"], next_cursor: null };
			},
			getNextPageParam: (page) => page.next_cursor ?? undefined,
			...transientQueryRetry,
		});
		const result = await new Promise<{ status: string }>((resolve) => {
			const unsubscribe = observer.subscribe((next) => {
				if (next.status !== "pending") {
					unsubscribe();
					resolve(next);
				}
			});
		});
		client.clear();
		expect(result.status).toBe("success");
		expect(calls).toBe(2);
	});

	test("network failures get the longer Web budget", () => {
		const offline = new ApiClientNetworkError("offline");
		expect(transientQueryRetry.retry(2, offline)).toBe(true);
		expect(transientQueryRetry.retry(3, offline)).toBe(false);
	});

	test("waits for the server's Retry-After before the next attempt", () => {
		expect(transientQueryRetry.retryDelay(0, new ApiClientError(503, null, 2_000))).toBe(2_000);
		expect(transientQueryRetry.retryDelay(1, new ApiClientError(503))).toBe(2_000);
		expect(transientQueryRetry.retryDelay(0, new ApiClientError(429, null, 600_000))).toBe(30_000);
	});
});
