import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	DeploymentOperation,
	HostedDeployment,
	HostedDeploymentStatus,
} from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import {
	deploymentFailurePresentation,
	deploymentFailureReason,
} from "@/hosted/deployment-failure";
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
type ShouldShowHostedProjectionNotice =
	typeof import("@/hosted/agents/hosted-agent-detail").shouldShowHostedProjectionNotice;
type RunManualDeploymentRefetch =
	typeof import("@/hosted/agents/agent-home").runManualDeploymentRefetch;
type OverviewFailureAction =
	typeof import("@/hosted/agents/hosted-agent-detail").OverviewFailureAction;
type OverviewComputeStatus =
	typeof import("@/hosted/agents/hosted-agent-detail").OverviewComputeStatus;
type InitialDeploymentPage =
	typeof import("@/hosted/agents/hosted-agent-detail").InitialDeploymentPage;

let invalidateSnapshots: InvalidateDeploymentSnapshots | null = null;
let projectAcceptedTransition: ProjectAcceptedDeploymentTransition | null = null;
let shouldShowProjectionNotice: ShouldShowHostedProjectionNotice | null = null;
let runManualDeploymentRefetch: RunManualDeploymentRefetch | null = null;
let overviewFailureAction: OverviewFailureAction | null = null;
let overviewComputeStatus: OverviewComputeStatus | null = null;
let initialDeploymentPage: InitialDeploymentPage | null = null;

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
	const agentHomeModule = await import("@/hosted/agents/agent-home");
	runManualDeploymentRefetch = agentHomeModule.runManualDeploymentRefetch;
	const detailModule = await import("@/hosted/agents/hosted-agent-detail");
	shouldShowProjectionNotice = detailModule.shouldShowHostedProjectionNotice;
	overviewFailureAction = detailModule.OverviewFailureAction;
	overviewComputeStatus = detailModule.OverviewComputeStatus;
	initialDeploymentPage = detailModule.InitialDeploymentPage;
});

describe("deployment failure remediation rendering", () => {
	test("renders a safe plan-change review link without internal failure details", () => {
		if (!overviewFailureAction) throw new Error("agent detail was not loaded");
		const deployment = hostedDeploymentFixture({
			id: "hdep_failed",
			status: "failed",
			acceptedOperation: acceptedOperation("plan_change"),
			failure: {
				type: "https://api.clawdi.ai/problems/operation_aborted",
				title: "MissingGreenlet during provisioning",
				status: 409,
				detail: "MissingGreenlet failed operations/plan-change-failed.",
				instance: "hdep_failed",
				code: "operation_aborted",
				phase: "plan_change",
				retryable: false,
				conditionReason: "OperationAborted",
				conditionMessage: "operations/plan-change-failed",
				observedGeneration: 2,
			},
		});
		const failure = deploymentFailurePresentation(deployment);
		if (!failure) throw new Error("Expected failure presentation");

		const markup = renderToStaticMarkup(
			createElement(overviewFailureAction, {
				deployment,
				failure,
				planChangeHref: "/agents/env_test/settings?source=on-clawdi",
				providerSettingsHref: "/agents/env_test/model-provider?source=on-clawdi",
				onDeleteAccepted: () => undefined,
			}),
		);

		expect(markup).toContain("Get fresh quote");
		expect(markup).toContain('href="/agents/env_test/settings?source=on-clawdi"');
		expect(markup).not.toContain("MissingGreenlet");
		expect(markup).not.toContain("operations/plan-change-failed");
	});

	test("renders a support next step when no failure reason is available", () => {
		if (!overviewComputeStatus) throw new Error("agent detail was not loaded");
		const markup = renderToStaticMarkup(
			createElement(overviewComputeStatus, {
				deployment: hostedDeploymentFixture({ status: "failed" }),
				failure: null,
				showActions: false,
				planChangeHref: "/agents/env_test/settings?source=on-clawdi",
				providerSettingsHref: "/agents/env_test/model-provider?source=on-clawdi",
				onDeleteAccepted: () => undefined,
				deploymentTransitionTimedOut: false,
				isCheckingDeployment: false,
				onCheckDeploymentAgain: () => undefined,
			}),
		);

		expect(markup).toContain("The last compute change failed");
		expect(markup).toContain('href="mailto:support@clawdi.ai"');
		expect(markup).not.toContain("Deployment operation");
		expect(markup).not.toContain("failure reason and operation");
	});
});

describe("deployment transition timeout rendering", () => {
	test("maps creating, starting, and running onto three concise semantic stages", () => {
		if (!initialDeploymentPage) throw new Error("agent detail was not loaded");
		for (const fixture of [
			{
				status: "creating",
				runtime: "hermes",
				title: "Setting up Hermes",
				activeLabel: "Preparing your environment",
				step: "Step 1 of 3",
				currentStage: "creating",
				states: { creating: "active", starting: "pending", running: "pending" },
			},
			{
				status: "starting",
				runtime: "openclaw",
				title: "Setting up OpenClaw",
				activeLabel: "Installing OpenClaw",
				step: "Step 2 of 3",
				currentStage: "starting",
				states: { creating: "completed", starting: "active", running: "pending" },
			},
			{
				status: "running",
				runtime: "hermes",
				title: "Setting up Hermes",
				activeLabel: "Ready",
				step: "Step 3 of 3",
				currentStage: "running",
				states: { creating: "completed", starting: "completed", running: "completed" },
			},
		] as const) {
			const markup = renderToStaticMarkup(
				createElement(initialDeploymentPage, {
					deployment: hostedDeploymentFixture({
						status: fixture.status,
						runtime: fixture.runtime,
					}),
					deploymentTransitionTimedOut: false,
					isCheckingDeployment: false,
					onCheckDeploymentAgain: () => undefined,
				}),
			);

			expect(markup).toContain(fixture.title);
			expect(markup).not.toContain("Deploying your agent");
			expect(markup).not.toContain("Current status");
			expect(markup).toContain(fixture.activeLabel);
			expect(markup).toContain(fixture.step);
			expect(markup).toContain('aria-label="Deployment progress"');
			for (const [stage, state] of Object.entries(fixture.states)) {
				expect(markup).toMatch(
					new RegExp(
						`data-deployment-stage="${stage}" data-stage-state="${state}"${stage === fixture.currentStage ? ' aria-current="step"' : ""}`,
					),
				);
			}
			for (const shortLabel of ["Environment", "Install", "Ready"])
				expect(markup).toContain(`>${shortLabel}</p>`);
			expect(markup).toContain("updates automatically");
			if (fixture.status === "running") {
				expect(markup).not.toContain('data-slot="spinner"');
			} else {
				expect(markup).toContain('data-slot="spinner"');
				expect(markup).toContain('aria-hidden="true"');
			}
			expect(markup).not.toContain("aria-valuenow");
			expect(markup).not.toContain("RuntimeNotReady");
			expect(markup).not.toContain("DriverApplying");
			for (const configurationLabel of ["Plan", "CPU", "Memory", "Storage"])
				expect(markup).not.toContain(`>${configurationLabel}<`);
		}
	});

	test("keeps the delayed-start retry accessible", () => {
		if (!initialDeploymentPage) throw new Error("agent detail was not loaded");
		const markup = renderToStaticMarkup(
			createElement(initialDeploymentPage, {
				deployment: hostedDeploymentFixture({ status: "starting" }),
				deploymentTransitionTimedOut: true,
				isCheckingDeployment: false,
				onCheckDeploymentAgain: () => undefined,
			}),
		);

		expect(markup).toContain('role="alert"');
		expect(markup).toContain("Setup is taking longer than expected");
		expect(markup).toContain("Check again");
		expect(markup).not.toContain("Current status");
		expect(markup).toContain(">Installing OpenClaw</p>");
		expect(markup).toContain("Step 2 of 3");
		expect(markup).toContain('data-deployment-stage="starting" data-stage-state="active"');
		expect(markup).not.toContain('data-slot="spinner"');
	});

	test("keeps projection availability notices off the deployment-backed overview", () => {
		if (!shouldShowProjectionNotice) throw new Error("agent detail was not loaded");

		expect(shouldShowProjectionNotice("overview")).toBe(false);
		expect(shouldShowProjectionNotice("console")).toBe(false);
		expect(shouldShowProjectionNotice("terminal")).toBe(false);
		expect(shouldShowProjectionNotice("ai")).toBe(false);
		expect(shouldShowProjectionNotice("settings")).toBe(false);
		expect(shouldShowProjectionNotice("sessions")).toBe(true);
		expect(shouldShowProjectionNotice("skills")).toBe(true);
	});

	test("keeps overview actions status-authoritative when the projection is missing", () => {
		const detailSource = readFileSync(
			new URL("./hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		expect(detailSource).toContain(
			"showDeploymentActions={!deploymentRunning && !isStartingStatus(deploymentStatus)}",
		);
		expect(detailSource).toContain("!isStartingStatus(deploymentStatus)");
		expect(detailSource).not.toContain('projection.status === "resolved" &&');
	});

	test("wires the timed-out inventory state and real refetch action into the detail", () => {
		const source = readFileSync(new URL("./agent-home.tsx", import.meta.url), "utf8");
		const manualHandler = source.slice(
			source.indexOf("const handleCheckAgain"),
			source.indexOf("// No route may be classified as connected"),
		);

		expect(source).toContain("deploymentTransitionTimedOut,");
		expect(source).toContain("deploymentTransitionTimedOut={deploymentTransitionTimedOut}");
		expect(source).toContain("const [manualChecking, setManualChecking] = useState(false);");
		expect(manualHandler).toContain("manualCheckInFlightRef.current");
		expect(manualHandler).toContain(
			"await runManualDeploymentRefetch(refetch, setManualChecking);",
		);
		expect(manualHandler).not.toContain("isFetchingRef");
		expect(source).toContain("isChecking={manualChecking}");
		expect(source).toContain("isCheckingDeployment={manualChecking}");
		expect(source).toContain("onCheckDeploymentAgain={() => void handleCheckAgain()}");
		const detailSource = readFileSync(
			new URL("./hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		expect(detailSource).toContain("isChecking={isCheckingProjection}");
		expect(detailSource).not.toContain("isFetching={isCheckingProjection}");
	});

	test("gives a manual check local feedback while an ambient refetch is active", async () => {
		if (!runManualDeploymentRefetch) throw new Error("agent home was not loaded");
		let requestCount = 0;
		let ambientRequestAborted = false;
		let resolveManualRequest: ((value: string) => void) | undefined;
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const observer = new QueryObserver(client, {
			queryKey: ["test", "manual-check-during-ambient-refetch"],
			queryFn: ({ signal }) => {
				requestCount += 1;
				if (requestCount === 1) {
					return new Promise<string>((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => {
								ambientRequestAborted = true;
								reject(new Error("ambient request aborted"));
							},
							{ once: true },
						);
					});
				}
				return new Promise<string>((resolve) => {
					resolveManualRequest = resolve;
				});
			},
			initialData: "cached deployment",
		});
		const unsubscribe = observer.subscribe(() => undefined);
		const ambientRefetch = observer.refetch({ cancelRefetch: false });
		const checkingStates: boolean[] = [];

		const manualRefetch = runManualDeploymentRefetch(
			() => observer.refetch(),
			(checking) => checkingStates.push(checking),
		);

		expect(checkingStates).toEqual([true]);
		expect(requestCount).toBe(2);
		expect(ambientRequestAborted).toBe(true);
		if (!resolveManualRequest) throw new Error("manual request did not start");
		resolveManualRequest("fresh deployment");
		await Promise.all([ambientRefetch, manualRefetch]);

		expect(checkingStates).toEqual([true, false]);
		expect(observer.getCurrentResult().data).toBe("fresh deployment");
		unsubscribe();
		client.clear();
	});
});

describe("hosted agent customer language", () => {
	test("uses grounded deployment language across hosted surfaces", () => {
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
		expect(detailSource).toMatch(/Setting up \$\{runtimeLabel\}/);
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
			'<RuntimeUiCredentialRow label="Token" value={renderedCredentials.token} secret />',
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
		queryClient.setQueryData(["get", "/v1/agents"], []);

		if (!invalidateSnapshots) throw new Error("deployment hooks were not loaded");
		invalidateSnapshots(queryClient);

		expect(queryClient.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(["get", "/v1/agents"])?.isInvalidated).toBe(true);
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
