import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
	type AcceptedDeploymentNavigate,
	navigateToAcceptedDeployment,
} from "@/hosted/billing/deploy/accepted-deployment-navigation";
import { billingKeys } from "@/hosted/billing/query-keys";

describe("accepted deployment navigation", () => {
	test("starts the stale inventory refresh and navigates without waiting for it", async () => {
		let inventoryRequests = 0;
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		queryClient.setQueryData(billingKeys.deployments, []);
		queryClient.setQueryData(["agents"], []);
		const observer = new QueryObserver(queryClient, {
			queryKey: billingKeys.deployments,
			queryFn: () => {
				inventoryRequests += 1;
				return new Promise<never[]>(() => undefined);
			},
		});
		const unsubscribe = observer.subscribe(() => undefined);
		const requestsBeforeAcceptance = inventoryRequests;
		const navigations: Parameters<AcceptedDeploymentNavigate>[0][] = [];

		navigateToAcceptedDeployment({
			deploymentId: "hdep_created",
			navigate: (options) => navigations.push(options),
			queryClient,
		});

		expect(inventoryRequests).toBe(requestsBeforeAcceptance + 1);
		expect(observer.getCurrentResult().isFetching).toBe(true);
		expect(navigations).toEqual([
			{ href: "/agents/hdep_created?source=on-clawdi", replace: false },
		]);
		expect(queryClient.getQueryState(["agents"])?.isInvalidated).toBe(true);

		await queryClient.cancelQueries({ queryKey: billingKeys.deployments });
		unsubscribe();
		queryClient.clear();
	});

	test("supports replacing redirect-return history without changing the canonical route", () => {
		const queryClient = new QueryClient();
		const navigations: Parameters<AcceptedDeploymentNavigate>[0][] = [];
		navigateToAcceptedDeployment({
			deploymentId: "hdep_returned",
			navigate: (options) => navigations.push(options),
			queryClient,
			replace: true,
		});
		expect(navigations).toEqual([
			{ href: "/agents/hdep_returned?source=on-clawdi", replace: true },
		]);
		queryClient.clear();
	});
});
