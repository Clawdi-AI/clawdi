import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
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

	test("rejects a deployment response without a canonical Agent UUID", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const authoritative = hostedDeploymentFixture({
			id: "hdep_invalid_identity",
			agentId: "hdep_invalid_identity",
		});

		await expect(
			navigateToAcceptedDeployment({
				deploymentId: authoritative.resource.id,
				getDeployment: async () => authoritative,
				navigate: () => {
					throw new Error("navigation must not run");
				},
				queryClient,
			}),
		).rejects.toThrow("invalid Agent identity");
		expect(queryClient.getQueryData(billingKeys.deployments)).toBeUndefined();
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
