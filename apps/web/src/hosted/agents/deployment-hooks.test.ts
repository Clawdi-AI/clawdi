import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import type { DeploymentOperation, HostedDeployment } from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import { deploymentFailureReason } from "@/hosted/deployment-failure";
import {
	DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
	deploymentRefetchInterval,
} from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

type InvalidateDeploymentSnapshots =
	typeof import("@/hosted/agents/deployment-hooks").invalidateDeploymentSnapshots;
type ProjectAcceptedDeploymentTransition =
	typeof import("@/hosted/agents/deployment-hooks").projectAcceptedDeploymentTransition;

let invalidateSnapshots: InvalidateDeploymentSnapshots | null = null;
let projectAcceptedTransition: ProjectAcceptedDeploymentTransition | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/agents/deployment-hooks");
	invalidateSnapshots = module.invalidateDeploymentSnapshots;
	projectAcceptedTransition = module.projectAcceptedDeploymentTransition;
});

function acceptedOperation(verb: DeploymentOperation["metadata"]["verb"]): DeploymentOperation {
	return {
		name: `operations/${verb}-accepted`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_test",
			verb,
			targetGeneration: 2,
			manifestETag: "manifest-accepted",
			createTime: "2026-07-24T00:00:00Z",
			updateTime: "2026-07-24T00:00:00Z",
		},
		done: false,
		response: null,
	};
}

describe("deployment mutation settlement", () => {
	test("invalidates deployment membership and its additive agent projection together", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(billingKeys.deployments, []);
		queryClient.setQueryData(["agents"], []);

		if (!invalidateSnapshots) throw new Error("deployment hooks were not loaded");
		invalidateSnapshots(queryClient);

		expect(queryClient.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(["agents"])?.isInvalidated).toBe(true);
	});

	test("uses the shared invalidation on every inventory-changing mutation settlement", () => {
		const source = readFileSync(new URL("./deployment-hooks.ts", import.meta.url), "utf8");
		const settlementInvalidations = source.match(
			/onSettled: \(\) => invalidateDeploymentSnapshots\(qc\)/g,
		);

		// Declarative lifecycle, delete, and settings updates all reconcile even
		// when the request rejects or times out.
		expect(settlementInvalidations).toHaveLength(3);
	});

	test("projects every accepted operation through the shared transition model", () => {
		if (!projectAcceptedTransition) throw new Error("deployment hooks were not loaded");
		const queryClient = new QueryClient();
		queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, [
			hostedDeploymentFixture({ id: "hdep_test" }),
		]);
		const expectations = [
			["create", "creating"],
			["start", "starting"],
			["stop", "stopping"],
			["restart", "restarting"],
			["update", "updating"],
			["delete", "deleting"],
		] as const;

		for (const [verb, status] of expectations) {
			const operation = acceptedOperation(verb);
			const accepted = { deploymentId: "hdep_test", operation };
			projectAcceptedTransition(queryClient, accepted, () => undefined);
			const deployments = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);

			expect(deployments?.[0]?.resource.status.summary_state).toBe(status);
			expect(deployments?.[0]?.accepted_operation).toEqual(operation);
			expect(
				deploymentRefetchInterval(
					deployments?.map((deployment) => ({
						status: deployment.resource.status.summary_state,
					})),
				),
			).toBe(DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS);
		}
	});

	test("keeps an accepted delete in cache so a later failure can replace it", () => {
		if (!projectAcceptedTransition) throw new Error("deployment hooks were not loaded");
		const queryClient = new QueryClient();
		queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, [
			hostedDeploymentFixture({ id: "hdep_delete" }),
		]);
		projectAcceptedTransition(
			queryClient,
			{ deploymentId: "hdep_delete", operation: acceptedOperation("delete") },
			() => undefined,
		);

		const deleting = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);
		expect(deleting).toHaveLength(1);
		expect(deleting?.[0]?.resource.status.summary_state).toBe("deleting");

		const failure = {
			type: "https://api.clawdi.ai/problems/deployment-delete-failed",
			title: "Deployment deletion failed",
			status: 409,
			detail: "The deployment could not be deleted.",
			instance: "hdep_delete",
			code: "deployment_delete_failed",
			conditionReason: "DeploymentDeleteFailed",
			conditionMessage: "The deployment could not be deleted.",
			observedGeneration: 2,
		};
		queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, [
			hostedDeploymentFixture({ id: "hdep_delete", status: "failed", failure }),
		]);

		const failed = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);
		expect(failed).toHaveLength(1);
		expect(failed?.[0]?.resource.status.summary_state).toBe("failed");
		expect(deploymentFailureReason(failed?.[0]?.resource.status ?? {})).toBe(
			"Deployment deletion failed",
		);
	});
});
