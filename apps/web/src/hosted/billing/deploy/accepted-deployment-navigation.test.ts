import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { createBillingClient } from "@/hosted/billing/billing-client";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	type AcceptedDeploymentNavigate,
	navigateToAcceptedDeployment,
	navigateToAcceptedDeploymentRequest,
} from "@/hosted/billing/deploy/accepted-deployment-navigation";
import { billingKeys } from "@/hosted/billing/query-keys";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("accepted deployment navigation", () => {
	test("waits for authoritative membership before opening the accepted Agent route", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const authoritative = hostedDeploymentFixture({
			id: "hdep_fast_handoff",
			agentId: "11111111-1111-4111-8111-111111111111",
			status: "creating",
		});
		queryClient.setQueryData(billingKeys.deployments, []);
		const hydration = deferred<HostedDeployment>();
		const hydrationStarted = deferred<void>();
		const events: string[] = [];

		const handoff = navigateToAcceptedDeployment({
			deploymentId: authoritative.resource.id,
			getDeployment: async () => {
				events.push("hydrate");
				hydrationStarted.resolve();
				return hydration.promise;
			},
			navigate: async ({ href }) => {
				expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toEqual([
					authoritative,
				]);
				events.push(`navigate:${href}`);
			},
			queryClient,
		});

		await hydrationStarted.promise;
		expect(events).toEqual(["hydrate"]);
		expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toEqual([]);

		hydration.resolve(authoritative);
		await handoff;
		expect(events).toEqual(["hydrate", "navigate:/agents/11111111-1111-4111-8111-111111111111"]);
		expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toEqual([
			authoritative,
		]);
		queryClient.clear();
	});

	test("cancels a stale list before authoritative cache handoff and navigation", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const staleList = deferred<HostedDeployment[]>();
		const relatedRead = deferred<HostedDeployment>();
		const existing = hostedDeploymentFixture({ id: "hdep_existing" });
		const staleCreated = hostedDeploymentFixture({
			id: "hdep_created",
			name: "Stale agent",
			status: "creating",
		});
		const authoritative = hostedDeploymentFixture({
			id: "hdep_created",
			agentId: "22222222-2222-4222-8222-222222222222",
			name: "Committed agent",
			status: "starting",
		});
		const agentsProjection = [{ id: "agent_before_acceptance" }];
		queryClient.setQueryData(billingKeys.deployments, [existing, staleCreated]);
		queryClient.setQueryData(["get", "/v1/agents"], agentsProjection);
		const inFlightStaleList = queryClient
			.fetchQuery({
				queryKey: billingKeys.deployments,
				queryFn: () => staleList.promise,
			})
			.catch(() => undefined);
		const inFlightRelatedRead = queryClient
			.fetchQuery({
				queryKey: [...billingKeys.deployments, "hdep_created"],
				queryFn: () => relatedRead.promise,
			})
			.catch(() => undefined);
		expect(queryClient.getQueryState(billingKeys.deployments)?.fetchStatus).toBe("fetching");

		const navigations: Parameters<AcceptedDeploymentNavigate>[0][] = [];
		await navigateToAcceptedDeployment({
			deploymentId: authoritative.resource.id,
			getDeployment: async () => authoritative,
			navigate: async (options) => {
				const cached = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);
				expect(cached).toEqual([existing, authoritative]);
				expect(queryClient.getQueryState(billingKeys.deployments)?.fetchStatus).toBe("idle");
				expect(
					queryClient.getQueryState([...billingKeys.deployments, "hdep_created"])?.fetchStatus,
				).toBe("fetching");
				expect(queryClient.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(false);
				navigations.push(options);
			},
			queryClient,
			replace: true,
		});

		staleList.resolve([]);
		relatedRead.resolve(authoritative);
		await staleList.promise;
		await relatedRead.promise;
		await inFlightStaleList;
		await inFlightRelatedRead;
		await Promise.resolve();
		expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toEqual([
			existing,
			authoritative,
		]);
		expect(navigations).toEqual([
			{ href: "/agents/22222222-2222-4222-8222-222222222222", replace: true },
		]);
		expect(queryClient.getQueryData<typeof agentsProjection>(["get", "/v1/agents"])).toBe(
			agentsProjection,
		);
		expect(queryClient.getQueryState(["get", "/v1/agents"])?.isInvalidated).toBe(true);
		expect(queryClient.getQueryCache().findAll({ queryKey: ["get", "/v1/agents"] })).toHaveLength(
			1,
		);

		queryClient.clear();
	});

	test("propagates accepted deployment hydration failure without navigating", async () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(billingKeys.deployments, []);
		const failure = new Error("Deployment read unavailable");
		let navigated = false;
		await expect(
			navigateToAcceptedDeployment({
				deploymentId: "hdep_accepted",
				getDeployment: async () => {
					throw failure;
				},
				navigate: () => {
					navigated = true;
				},
				queryClient,
			}),
		).rejects.toBe(failure);
		expect(navigated).toBe(false);
		expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toEqual([]);
		queryClient.clear();
	});

	test.each([
		{
			id: "hdep_other",
			agentId: "11111111-1111-4111-8111-111111111111",
			error: "different deployment",
		},
		{ id: "hdep_expected", agentId: "hdep_invalid_identity", error: "invalid Agent identity" },
	])("rejects an authoritative response with $error", async ({ id, agentId, error }) => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const authoritative = hostedDeploymentFixture({ id, agentId });

		await expect(
			navigateToAcceptedDeployment({
				deploymentId: "hdep_expected",
				getDeployment: async () => authoritative,
				navigate: () => {
					throw new Error("navigation must not run");
				},
				queryClient,
			}),
		).rejects.toThrow(error);
		expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toBeUndefined();
		queryClient.clear();
	});

	test("opens the authenticated detail identity despite a replayed request's old Agent hint", async () => {
		const queryClient = new QueryClient();
		const authoritative = hostedDeploymentFixture({ id: "hdep_replayed", status: "creating" });
		const requests: string[] = [];
		const client = createBillingClient(async () => "current-token", {
			fetch: async (request) => {
				expect(request.method).toBe("GET");
				expect(request.headers.get("Authorization")).toBe("Bearer current-token");
				const path = new URL(request.url).pathname;
				requests.push(path);
				return Response.json(
					path.endsWith("/by-request/replayed")
						? {
								request_status: "processing",
								deploy_request_id: "replayed",
								lineage_tail: {
									deployment_id: authoritative.resource.id,
									agent_id: "00000000-0000-4000-8000-000000000000",
									lineage_version: 1,
									lineage_state: "processing",
								},
							}
						: authoritative,
				);
			},
		});
		const navigations: Parameters<AcceptedDeploymentNavigate>[0][] = [];
		await navigateToAcceptedDeploymentRequest({
			deployRequestId: "replayed",
			resolveDeploymentRequest: client.waitForDeploymentRequest,
			getDeployment: client.getDeployment,
			queryClient,
			navigate: (options) => {
				navigations.push(options);
			},
		});
		expect(requests).toEqual([
			"/v2/deployments/by-request/replayed",
			"/v2/deployments/hdep_replayed",
		]);
		expect(navigations).toEqual([{ href: `/agents/${authoritative.agent_id}`, replace: false }]);
		queryClient.clear();
	});

	test("resolves request lineage before the authoritative handoff and awaits navigation", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const authoritative = hostedDeploymentFixture({ id: "hdep_from_request", status: "creating" });
		const navigationGate = deferred<void>();
		const events: string[] = [];
		let settled = false;

		const handoff = navigateToAcceptedDeploymentRequest({
			deployRequestId: "checkout/stable:key",
			resolveDeploymentRequest: async (deployRequestId) => {
				events.push(`resolve:${deployRequestId}`);
				return { deploymentId: authoritative.resource.id };
			},
			getDeployment: async (deploymentId) => {
				events.push(`get:${deploymentId}`);
				return authoritative;
			},
			onAccepted: () => events.push("accepted"),
			navigate: async () => {
				events.push("navigate");
				expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toEqual([
					authoritative,
				]);
				await navigationGate.promise;
			},
			queryClient,
			replace: true,
		}).then(() => {
			settled = true;
		});

		for (let turn = 0; turn < 10 && !events.includes("navigate"); turn += 1) {
			await Promise.resolve();
		}
		expect(events).toEqual([
			"resolve:checkout/stable:key",
			"accepted",
			"get:hdep_from_request",
			"navigate",
		]);
		expect(settled).toBe(false);

		navigationGate.resolve();
		await handoff;
		expect(settled).toBe(true);
		queryClient.clear();
	});
});
