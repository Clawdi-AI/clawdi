import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	type AcceptedDeploymentNavigate,
	navigateToAcceptedDeployment,
	upsertAuthoritativeDeployment,
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
	test("immutably inserts and replaces authoritative deployment rows", () => {
		const existing = hostedDeploymentFixture({ id: "hdep_existing" });
		const created = hostedDeploymentFixture({ id: "hdep_created", status: "creating" });
		const initial = [existing];

		const inserted = upsertAuthoritativeDeployment(initial, created);
		expect(inserted).not.toBe(initial);
		expect(inserted).toEqual([existing, created]);
		expect(initial).toEqual([existing]);

		const refreshed = hostedDeploymentFixture({
			id: "hdep_created",
			name: "Committed name",
			status: "starting",
		});
		const replaced = upsertAuthoritativeDeployment(inserted, refreshed);
		expect(replaced).not.toBe(inserted);
		expect(replaced[0]).toBe(existing);
		expect(replaced[1]).toBe(refreshed);
	});

	test("cancels an in-flight stale list before upsert and navigates from the seeded authority", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const staleList = deferred<HostedDeployment[]>();
		const existing = hostedDeploymentFixture({ id: "hdep_existing" });
		const authoritative = hostedDeploymentFixture({
			id: "hdep_created",
			name: "Committed agent",
			status: "creating",
		});
		const agentsProjection = [{ id: "agent_before_acceptance" }];
		queryClient.setQueryData(billingKeys.deployments, [existing]);
		queryClient.setQueryData(["agents"], agentsProjection);
		let inventoryRequests = 0;
		const observer = new QueryObserver(queryClient, {
			queryKey: billingKeys.deployments,
			queryFn: () => {
				inventoryRequests += 1;
				return staleList.promise;
			},
			staleTime: 0,
		});
		const unsubscribe = observer.subscribe(() => undefined);
		expect(inventoryRequests).toBe(1);
		expect(observer.getCurrentResult().isFetching).toBe(true);

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
		});

		// This response began before acceptance and arrives after hydration and
		// navigation. Cancellation must prevent it from replacing the committed row.
		staleList.resolve([]);
		await staleList.promise;
		await Promise.resolve();
		expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toEqual([
			existing,
			authoritative,
		]);
		expect(navigations).toEqual([
			{ href: "/agents/hdep_created?source=on-clawdi", replace: false },
		]);
		expect(queryClient.getQueryData<typeof agentsProjection>(["agents"])).toBe(agentsProjection);
		expect(queryClient.getQueryState(["agents"])?.isInvalidated).toBe(true);
		expect(queryClient.getQueryCache().findAll({ queryKey: ["agents"] })).toHaveLength(1);

		unsubscribe();
		queryClient.clear();
	});

	test("a hydration retry only repeats the by-id read before replacing history", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, []);
		const authoritative = hostedDeploymentFixture({ id: "hdep_returned", status: "starting" });
		let detailReads = 0;
		const getDeployment = async () => {
			detailReads += 1;
			if (detailReads === 1) throw new Error("detail temporarily unavailable");
			return authoritative;
		};
		const navigations: Parameters<AcceptedDeploymentNavigate>[0][] = [];
		const hydrate = () =>
			navigateToAcceptedDeployment({
				deploymentId: "hdep_returned",
				getDeployment,
				navigate: (options) => {
					navigations.push(options);
				},
				queryClient,
				replace: true,
			});

		await expect(hydrate()).rejects.toThrow("detail temporarily unavailable");
		expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toEqual([]);
		expect(navigations).toEqual([]);

		await hydrate();
		expect(detailReads).toBe(2);
		expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toEqual([
			authoritative,
		]);
		expect(queryClient.getQueryData(["agents"])).toBeUndefined();
		expect(queryClient.getQueryCache().findAll({ queryKey: ["agents"] })).toHaveLength(0);
		expect(navigations).toEqual([
			{ href: "/agents/hdep_returned?source=on-clawdi", replace: true },
		]);
		queryClient.clear();
	});
});
