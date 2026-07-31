import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	DeploymentOperation,
	HostedDeployment,
	HostedDeploymentStatus,
} from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import { deploymentFailureReason } from "@/hosted/deployment-failure";
import {
	DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
	type DeploymentOperationVerb,
	deploymentRefetchInterval,
} from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

type InvalidateDeploymentSnapshots =
	typeof import("@/hosted/agents/deployment-hooks").invalidateDeploymentSnapshots;
type ProjectAcceptedDeploymentTransition =
	typeof import("@/hosted/agents/deployment-hooks").projectAcceptedDeploymentTransition;
type OverviewReadinessPanel =
	typeof import("@/hosted/agents/hosted-agent-detail").OverviewReadinessPanel;
type OverviewFailedPanel = typeof import("@/hosted/agents/hosted-agent-detail").OverviewFailedPanel;

let invalidateSnapshots: InvalidateDeploymentSnapshots | null = null;
let projectAcceptedTransition: ProjectAcceptedDeploymentTransition | null = null;
let overviewReadinessPanel: OverviewReadinessPanel | null = null;
let overviewFailedPanel: OverviewFailedPanel | null = null;

function requiredDeploymentStatus(
	deployment: HostedDeployment | undefined,
): HostedDeploymentStatus {
	if (!deployment) throw new Error("Expected deployment fixture");
	const status = deployment.resource.status;
	if (status === null) throw new Error("Expected deployment status fixture");
	return status;
}

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/agents/deployment-hooks");
	invalidateSnapshots = module.invalidateDeploymentSnapshots;
	projectAcceptedTransition = module.projectAcceptedDeploymentTransition;
	const detailModule = await import("@/hosted/agents/hosted-agent-detail");
	overviewReadinessPanel = detailModule.OverviewReadinessPanel;
	overviewFailedPanel = detailModule.OverviewFailedPanel;
});

describe("deployment failure remediation rendering", () => {
	test("routes a failed plan change through review without startup or bare restart copy", () => {
		if (!overviewFailedPanel) throw new Error("agent detail was not loaded");
		const operation: DeploymentOperation = {
			name: "operations/plan-change-failed",
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: "hdep_failed",
				verb: "plan_change" as DeploymentOperation["metadata"]["verb"],
				targetGeneration: 2,
				manifestETag: "manifest-failed",
				createTime: "2026-07-25T00:00:00Z",
				updateTime: "2026-07-25T00:01:00Z",
			},
			done: false,
			response: null,
		};
		const deployment = hostedDeploymentFixture({
			id: "hdep_failed",
			status: "failed",
			acceptedOperation: operation,
			failure: {
				type: "https://api.clawdi.ai/problems/operation_aborted",
				title: "Deployment operation was aborted",
				status: 409,
				detail:
					"MissingGreenlet prevented synchronous plan confirmation for operations/plan-change-failed.",
				instance: "hdep_failed",
				code: "operation_aborted",
				phase: "plan_change",
				retryable: false,
				conditionReason: "OperationAborted",
				conditionMessage: "Deployment operation was aborted",
				observedGeneration: 2,
			},
		});

		const markup = renderToStaticMarkup(
			createElement(overviewFailedPanel, {
				deployment,
				planChangeHref: "/agents/env_test/settings?source=on-clawdi",
				providerSettingsHref: "/agents/env_test/model-provider?source=on-clawdi",
				onDeleteAccepted: () => undefined,
			}),
		);

		expect(markup).toContain("Plan change failed");
		expect(markup).toContain("The Clawdi service could not confirm the plan change.");
		expect(markup).toContain("Your plan was not changed and you were not charged.");
		expect(markup).toContain("Get a fresh quote and confirm the price before trying again.");
		expect(markup).toContain("Get fresh quote");
		expect(markup).not.toContain("MissingGreenlet");
		expect(markup).not.toContain("operations/plan-change-failed");
		expect(markup).not.toContain("provisioning");
		expect(markup).not.toContain("synchronous plan confirmation");
		expect(markup).not.toContain("Agent setup failed");
		expect(markup).not.toContain("retry startup");
		expect(markup).not.toContain("Restart compute");
	});

	test("gives an unexplained failure customer language and a working next step", () => {
		if (!overviewFailedPanel) throw new Error("agent detail was not loaded");
		const markup = renderToStaticMarkup(
			createElement(overviewFailedPanel, {
				deployment: hostedDeploymentFixture({ status: "failed" }),
				planChangeHref: "/agents/env_test/settings?source=on-clawdi",
				providerSettingsHref: "/agents/env_test/model-provider?source=on-clawdi",
				onDeleteAccepted: () => undefined,
			}),
		);

		expect(markup).toContain("Agent change failed");
		expect(markup).toContain("Clawdi couldn’t complete the last change to this agent");
		expect(markup).toContain("It isn’t safe to try again automatically");
		expect(markup).toContain('href="mailto:support@clawdi.ai"');
		expect(markup).not.toContain("Deployment operation");
		expect(markup).not.toContain("failure reason and operation");
	});
});

describe("deployment transition timeout rendering", () => {
	test("keeps startup overview actions hidden until startup and projection resolve", () => {
		const detailSource = readFileSync(
			new URL("./hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		expect(detailSource).toContain('projection.status === "resolved" &&');
		expect(detailSource).toContain("!isStartingStatus(deploymentStatus)");
		expect(detailSource).not.toContain(
			'showDeploymentActions={projection.status !== "resolved" || !deploymentRunning}',
		);
	});

	test("keeps delayed startup copy truthful with automatic and manual checks", () => {
		if (!overviewReadinessPanel) throw new Error("agent detail was not loaded");
		const deployment = hostedDeploymentFixture({ status: "creating" });
		const commonProps = {
			deployment,
			isCheckingDeployment: false,
			onCheckDeploymentAgain: () => undefined,
		};

		const converging = renderToStaticMarkup(
			createElement(overviewReadinessPanel, {
				...commonProps,
				deploymentTransitionTimedOut: false,
			}),
		);
		const timedOut = renderToStaticMarkup(
			createElement(overviewReadinessPanel, {
				...commonProps,
				deploymentTransitionTimedOut: true,
			}),
		);

		expect(converging).toContain("Starting your agent…");
		expect(converging).toContain("This step should finish within five minutes.");
		expect(converging).toContain("Startup continues if you leave this page");
		expect(converging).not.toContain("Provisioning");
		expect(converging).not.toContain("Booting");
		expect(converging).not.toContain("Current status");
		expect(converging).not.toContain("Deployment progress");
		expect(timedOut).toContain("Your agent is taking longer than expected");
		expect(timedOut).toContain("latest status still shows your agent starting");
		expect(timedOut).toContain("Startup may still be continuing");
		expect(timedOut).toContain("keep checking automatically once a minute");
		expect(timedOut).toContain("Check again");
		expect(timedOut).not.toContain("Automatic checks have stopped");
		expect(timedOut).not.toContain("Startup continues if you leave this page");
	});

	test("makes the authoritative running state unambiguously Running", () => {
		if (!overviewReadinessPanel) throw new Error("agent detail was not loaded");
		const ready = renderToStaticMarkup(
			createElement(overviewReadinessPanel, {
				deployment: hostedDeploymentFixture({ status: "running" }),
				deploymentTransitionTimedOut: false,
				isCheckingDeployment: false,
				onCheckDeploymentAgain: () => undefined,
			}),
		);

		expect(ready).toContain("Your agent is running");
		expect(ready).toContain("It is ready to use");
		expect(ready).not.toContain("automatically");
		expect(ready).not.toContain("Provisioning");
		expect(ready).not.toContain("Booting");
	});

	test("wires the timed-out inventory state and real refetch action into the detail", () => {
		const source = readFileSync(new URL("./agent-home.tsx", import.meta.url), "utf8");

		expect(source).toContain("deploymentTransitionTimedOut,");
		expect(source).toContain("deploymentTransitionTimedOut={deploymentTransitionTimedOut}");
		expect(source).toContain("onCheckDeploymentAgain={handleCheckAgain}");
		expect(source).toContain("void refetch();");
	});
});

describe("hosted agent customer language", () => {
	test("uses Starting and Running as lifecycle state vocabulary across surfaces", () => {
		const detailSource = readFileSync(
			new URL("./hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		const agentHomeSource = readFileSync(new URL("./agent-home.tsx", import.meta.url), "utf8");
		const sidebarSource = readFileSync(
			new URL("../../components/app-sidebar.tsx", import.meta.url),
			"utf8",
		);
		const wizardSource = readFileSync(
			new URL("../billing/deploy/deploy-wizard.tsx", import.meta.url),
			"utf8",
		);
		const customerCopy = `${detailSource}\n${agentHomeSource}\n${sidebarSource}\n${wizardSource}`;

		for (const staleLifecycleCopy of [
			"Provisioning",
			"Booting",
			"Getting your agent ready",
			"Setting up your agent",
			"Your agent is ready",
			"After your agent is ready",
		]) {
			expect(customerCopy).not.toContain(staleLifecycleCopy);
		}
		expect(detailSource).toContain("Starting your agent…");
		expect(detailSource).toContain("Your agent is running");
		expect(wizardSource).not.toContain("After your agent is running");
	});

	test("keeps delayed and unavailable states honest without implementation vocabulary", () => {
		const detailSource = readFileSync(
			new URL("./hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		const sidebarSource = readFileSync(
			new URL("../../components/app-sidebar.tsx", import.meta.url),
			"utf8",
		);
		const customerCopy = `${detailSource}\n${sidebarSource}`;

		for (const internalCopy of [
			"Sync record unavailable",
			"synced agent record",
			"Deployment actions",
			"Manage hosted compute independently of synced agent data.",
			"Apply locale changes directly",
			"finishes booting",
			"Deployment operation failed",
			"failure reason and operation",
		]) {
			expect(customerCopy).not.toContain(internalCopy);
		}
		expect(detailSource).toContain("Some agent details are unavailable");
		expect(detailSource).toContain("Clawdi can’t load every part of this agent right now.");
		expect(detailSource).toContain("title={`Agent status: ");
		expect(sidebarSource).toContain('"Agent details unavailable"');
	});

	test("shares one access dialog and keeps both runtime interfaces embedded", () => {
		const detailSource = readFileSync(
			new URL("./hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);

		expect(detailSource.match(/getRuntimeUiCredentials/g)).toHaveLength(1);
		expect(detailSource).toContain("openSecureRuntimeWindow");
		expect(detailSource).toContain("resolveRuntimeUiCredentials");
		expect(detailSource).toContain("runtimeUiLaunchTarget");
		expect(detailSource).toContain("RuntimeUiAccessDialog");
		expect(detailSource).toContain("Runtime UI access");
		expect(detailSource).toContain("<iframe");
		expect(detailSource).toContain('allow="clipboard-read; clipboard-write"');
		expect(detailSource).toContain("Open in new window");
		expect(detailSource).toContain('<RuntimeUiCredentialRow label="Username"');
		expect(detailSource).toContain('<RuntimeUiCredentialRow label="Password"');
		expect(detailSource).toContain(
			'<RuntimeUiCredentialRow label="Token" value={credentials.token} secret />',
		);
		expect(detailSource).toContain("Sign in to Hermes");
		expect(detailSource).toContain("Get your Hermes username and password from Access.");
		expect(detailSource).toContain("clawdi.hermes-access-hint.dismissed");
		expect(detailSource).toContain('runtime === "hermes" && accessHintOpen');
		expect(detailSource).not.toContain("reconciliationRequired");
	});
});

function acceptedOperation(verb: DeploymentOperationVerb): DeploymentOperation {
	return {
		name: `operations/${verb}-accepted`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_test",
			verb: verb as DeploymentOperation["metadata"]["verb"],
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

		// Declarative lifecycle, access reset, delete, and settings updates all reconcile even
		// when the request rejects or times out.
		expect(settlementInvalidations).toHaveLength(4);
	});

	test("describes accepted deletion as background cleanup and replace-navigates detail", () => {
		const hooksSource = readFileSync(new URL("./deployment-hooks.ts", import.meta.url), "utf8");
		const homeSource = readFileSync(new URL("./agent-home.tsx", import.meta.url), "utf8");
		const actionSource = readFileSync(
			new URL("./deployment-delete-action.tsx", import.meta.url),
			"utf8",
		);

		expect(hooksSource).toContain('toast.message("Agent removed", {');
		expect(hooksSource).toContain('description: "Cleanup continues in the background."');
		expect(homeSource).toContain(
			'onDeleteAccepted={() => router.navigate({ href: "/", replace: true })}',
		);
		expect(actionSource).toContain('await router.navigate({ href: "/", replace: true });');
	});

	test("retires old runtime windows only after restart, access reset, or delete is accepted", () => {
		const source = readFileSync(new URL("./deployment-hooks.ts", import.meta.url), "utf8");

		expect(source).toContain('if (vars.action === "restart") {');
		expect(source).toContain("retireRuntimeWindows(accepted.deploymentId);");
		expect(source.match(/retireRuntimeWindows\(accepted\.deploymentId/g)).toHaveLength(3);
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
			["reset_runtime_ui_access", "restarting"],
			["update", "updating"],
			["plan_change", "updating"],
			["runtime_switch", "updating"],
			["rename", "updating"],
			["delete", "deleting"],
		] as const;

		for (const [verb, status] of expectations) {
			const operation = acceptedOperation(verb);
			const accepted = { deploymentId: "hdep_test", operation };
			projectAcceptedTransition(queryClient, accepted, () => undefined);
			const deployments = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);
			const resourceStatus = requiredDeploymentStatus(deployments?.[0]);

			expect(resourceStatus.summary_state).toBe(status);
			expect(resourceStatus.failure).toBeNull();
			expect(deployments?.[0]?.accepted_operation).toEqual(operation);
			expect(
				deploymentRefetchInterval(deployments, new Map(), Date.parse("2026-07-24T00:00:00Z")),
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
		expect(requiredDeploymentStatus(deleting?.[0]).summary_state).toBe("deleting");

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
		const failedStatus = requiredDeploymentStatus(failed?.[0]);
		expect(failedStatus.summary_state).toBe("failed");
		expect(deploymentFailureReason(failedStatus)).toBe(
			"The Clawdi service could not complete this request.",
		);
	});

	test("does not fabricate a status while projecting an accepted operation", () => {
		if (!projectAcceptedTransition) throw new Error("deployment hooks were not loaded");
		const queryClient = new QueryClient();
		queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, [
			hostedDeploymentFixture({ id: "hdep_unknown", status: null }),
		]);
		const operation = acceptedOperation("start");

		projectAcceptedTransition(
			queryClient,
			{ deploymentId: "hdep_unknown", operation },
			() => undefined,
		);

		const [projected] = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments) ?? [];
		expect(projected?.resource.status).toBeNull();
		expect(projected?.accepted_operation).toEqual(operation);
	});
});
