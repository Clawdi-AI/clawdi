import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	type AcceptedDeploymentNavigate,
	navigateToAcceptedDeployment,
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
		const existing = hostedDeploymentFixture({ id: "hdep_existing" });
		const staleCreated = hostedDeploymentFixture({
			id: "hdep_created",
			name: "Stale agent",
			status: "creating",
		});
		const authoritative = hostedDeploymentFixture({
			id: "hdep_created",
			name: "Committed agent",
			status: "starting",
		});
		const agentsProjection = [{ id: "agent_before_acceptance" }];
		queryClient.setQueryData(billingKeys.deployments, [existing, staleCreated]);
		queryClient.setQueryData(["agents"], agentsProjection);
		const inFlightStaleList = queryClient
			.fetchQuery({
				queryKey: billingKeys.deployments,
				queryFn: () => staleList.promise,
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
				expect(queryClient.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(false);
				navigations.push(options);
			},
			queryClient,
			replace: true,
		});

		staleList.resolve([]);
		await staleList.promise;
		await inFlightStaleList;
		await Promise.resolve();
		expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toEqual([
			existing,
			authoritative,
		]);
		expect(navigations).toEqual([{ href: "/agents/hdep_created?source=on-clawdi", replace: true }]);
		expect(queryClient.getQueryData<typeof agentsProjection>(["agents"])).toBe(agentsProjection);
		expect(queryClient.getQueryState(["agents"])?.isInvalidated).toBe(true);
		expect(queryClient.getQueryCache().findAll({ queryKey: ["agents"] })).toHaveLength(1);

		queryClient.clear();
	});
});
