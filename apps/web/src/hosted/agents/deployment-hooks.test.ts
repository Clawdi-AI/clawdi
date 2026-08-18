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
	deploymentStatusFromResource,
} from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

type InvalidateDeploymentSnapshots =
	typeof import("@/hosted/agents/deployment-hooks").invalidateDeploymentSnapshots;
type InvalidateDeploymentDeleteSnapshots =
	typeof import("@/hosted/agents/deployment-hooks").invalidateDeploymentDeleteSnapshots;
type ProjectAcceptedDeploymentTransition =
	typeof import("@/hosted/agents/deployment-hooks").projectAcceptedDeploymentTransition;
type SettleAcceptedDeploymentDelete =
	typeof import("@/hosted/agents/deployment-hooks").settleAcceptedDeploymentDelete;
type ShouldShowHostedProjectionNotice =
	typeof import("@/hosted/agents/hosted-agent-detail").shouldShowHostedProjectionNotice;
type RunManualDeploymentRefetch =
	typeof import("@/hosted/agents/agent-home").runManualDeploymentRefetch;
type OverviewComputeStatus =
	typeof import("@/hosted/agents/hosted-agent-detail").OverviewComputeStatus;
type OverviewComputeSummary =
	typeof import("@/hosted/agents/hosted-agent-detail").OverviewComputeSummary;
type InitialDeploymentPage =
	typeof import("@/hosted/agents/hosted-agent-detail").InitialDeploymentPage;
type ShouldShowInitialDeploymentProgress =
	typeof import("@/hosted/agents/hosted-agent-detail").shouldShowInitialDeploymentProgress;
type CanRetryInitialDeployment =
	typeof import("@/hosted/agents/hosted-agent-detail").canRetryInitialDeployment;

let invalidateSnapshots: InvalidateDeploymentSnapshots | null = null;
let invalidateDeleteSnapshots: InvalidateDeploymentDeleteSnapshots | null = null;
let projectAcceptedTransition: ProjectAcceptedDeploymentTransition | null = null;
let settleAcceptedDelete: SettleAcceptedDeploymentDelete | null = null;
let shouldShowProjectionNotice: ShouldShowHostedProjectionNotice | null = null;
let runManualDeploymentRefetch: RunManualDeploymentRefetch | null = null;
let overviewComputeStatus: OverviewComputeStatus | null = null;
let overviewComputeSummary: OverviewComputeSummary | null = null;
let initialDeploymentPage: InitialDeploymentPage | null = null;
let shouldShowInitialDeploymentProgress: ShouldShowInitialDeploymentProgress | null = null;
let canRetryInitialDeployment: CanRetryInitialDeployment | null = null;

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
	invalidateDeleteSnapshots = module.invalidateDeploymentDeleteSnapshots;
	projectAcceptedTransition = module.projectAcceptedDeploymentTransition;
	settleAcceptedDelete = module.settleAcceptedDeploymentDelete;
	const agentHomeModule = await import("@/hosted/agents/agent-home");
	runManualDeploymentRefetch = agentHomeModule.runManualDeploymentRefetch;
	const detailModule = await import("@/hosted/agents/hosted-agent-detail");
	shouldShowProjectionNotice = detailModule.shouldShowHostedProjectionNotice;
	overviewComputeStatus = detailModule.OverviewComputeStatus;
	overviewComputeSummary = detailModule.OverviewComputeSummary;
	initialDeploymentPage = detailModule.InitialDeploymentPage;
	shouldShowInitialDeploymentProgress = detailModule.shouldShowInitialDeploymentProgress;
	canRetryInitialDeployment = detailModule.canRetryInitialDeployment;
});

describe("deployment failure status rendering", () => {
	test("renders safe failure context without lifecycle or destructive actions", () => {
		if (!overviewComputeStatus) throw new Error("agent detail was not loaded");
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
			createElement(overviewComputeStatus, {
				deployment,
				failure,
				deploymentTransitionTimedOut: false,
				deploymentTransitionEscalated: false,
			}),
		);

		expect(markup).toContain("Plan change failed");
		expect(markup).toContain("plan was not changed");
		expect(markup).not.toContain("MissingGreenlet");
		expect(markup).not.toContain("operations/plan-change-failed");
		expect(markup).not.toContain("<button");
		expect(markup).not.toContain("<a");
		for (const action of ["Delete", "Retry", "Restart", "Start", "Open Wallet"])
			expect(markup).not.toContain(`>${action}`);
	});

	test("renders a concise generic failure without inventing a remedy", () => {
		if (!overviewComputeStatus) throw new Error("agent detail was not loaded");
		const markup = renderToStaticMarkup(
			createElement(overviewComputeStatus, {
				deployment: hostedDeploymentFixture({ status: "failed" }),
				failure: null,
				deploymentTransitionTimedOut: false,
				deploymentTransitionEscalated: false,
			}),
		);

		expect(markup).toContain("The last compute change did not complete");
		expect(markup).not.toContain("mailto:");
		expect(markup).not.toContain("try again");
		expect(markup).not.toContain("Deployment operation");
		expect(markup).not.toContain("failure reason and operation");
	});

	test("renders a later runtime failure without blaming a successful restart", () => {
		if (!overviewComputeStatus) throw new Error("agent detail was not loaded");
		const running = hostedDeploymentFixture({ id: "hdep_runtime_degraded" });
		const deployment = hostedDeploymentFixture({
			id: "hdep_runtime_degraded",
			status: "failed",
			acceptedOperation: successfulOperation("restart", running),
			failure: {
				type: "https://api.clawdi.ai/problems/runtime-readiness-timeout",
				title: "Runtime apply failed",
				status: 504,
				detail: "Hermes prerequisite failed: internal build output",
				code: "runtime_readiness_timeout",
				phase: "reconcile",
				retryable: true,
				conditionReason: "RuntimeReadinessTimeout",
				conditionMessage: "internal runtime health error",
				observedGeneration: 2,
			},
		});
		const failure = deploymentFailurePresentation(deployment);
		if (!failure) throw new Error("Expected runtime failure presentation");

		const markup = renderToStaticMarkup(
			createElement(overviewComputeStatus, {
				deployment,
				failure,
				deploymentTransitionTimedOut: false,
				deploymentTransitionEscalated: false,
			}),
		);

		expect(markup).not.toContain("Temporarily unavailable");
		expect(markup.match(/Clawdi is checking the runtime/g)).toHaveLength(1);
		expect(markup).not.toContain("restart failed");
		expect(markup).not.toContain("Hermes prerequisite");
		expect(markup).not.toContain("internal runtime");
		expect(markup).not.toContain("<button");
		expect(markup).not.toContain("<a");
	});

	test("shows restart failure copy only for a terminal restart operation error", () => {
		if (!overviewComputeStatus) throw new Error("agent detail was not loaded");
		const deployment = hostedDeploymentFixture({
			status: "failed",
			acceptedOperation: failedOperation("restart"),
		});
		const failure = deploymentFailurePresentation(deployment);
		if (!failure) throw new Error("Expected restart failure presentation");

		const markup = renderToStaticMarkup(
			createElement(overviewComputeStatus, {
				deployment,
				failure,
				deploymentTransitionTimedOut: false,
				deploymentTransitionEscalated: false,
			}),
		);

		expect(markup).toContain("Agent restart failed");
		expect(markup).not.toContain("Retry restart");
		expect(markup).not.toContain("Delete");
		expect(markup).not.toContain("<button");
		expect(markup).not.toContain("<a");
	});

	test("keeps non-running status summaries action-free", () => {
		if (!overviewComputeStatus) throw new Error("agent detail was not loaded");
		for (const fixture of [
			{ status: "starting", copy: "Startup is still in progress.", spinner: true },
			{ status: "restarting", copy: "Restarting", spinner: true },
			{
				status: "stopped",
				copy: "Compute is stopped. Channels and the agent interface are unavailable.",
				spinner: false,
			},
			{
				status: null,
				copy: "Clawdi cannot confirm the current compute status.",
				spinner: false,
			},
		] as const) {
			const markup = renderToStaticMarkup(
				createElement(overviewComputeStatus, {
					deployment: hostedDeploymentFixture({ status: fixture.status }),
					failure: null,
					deploymentTransitionTimedOut: false,
					deploymentTransitionEscalated: false,
				}),
			);
			expect(markup).toContain(fixture.copy);
			expect(markup).not.toContain("<button");
			expect(markup).not.toContain("<a");
			expect(markup.includes('data-slot="spinner"')).toBe(fixture.spinner);
		}
	});
});

describe("overview Compute hierarchy", () => {
	test("keeps plan and configuration in one compact summary instead of metric tiles", () => {
		if (!overviewComputeSummary) throw new Error("agent detail was not loaded");
		const markup = renderToStaticMarkup(
			createElement(overviewComputeSummary, {
				plan: "Basic",
				vcpu: 2,
				memoryMib: 4096,
				storageGib: 20,
			}),
		);

		expect(markup).toContain("Basic plan");
		expect(markup).toContain("2 vCPU");
		expect(markup).toContain("4 GiB memory");
		expect(markup).toContain("20 GiB storage");
		expect(markup).toContain('aria-label="Configuration: 2 vCPU, 4 GiB memory, 20 GiB storage"');
		expect(markup).toContain('data-testid="overview-compute-summary"');
		expect(markup).toContain('data-overview-compute-plan="true"');
		expect(markup).toContain("text-sm text-muted-foreground");
		expect(markup).not.toContain("text-sm font-medium text-muted-foreground");
		expect(markup).not.toContain("text-sm font-semibold");
		expect(markup).not.toContain("grid-cols-2");
		expect(markup).not.toContain("rounded");
		expect(markup).not.toContain("border");
		expect(markup).not.toContain("bg-");
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
				activeLabel: "Preparing cloud resources",
				activeDescription: "Creating a private environment and connecting your AI provider.",
				step: "Step 1 of 3",
				currentStage: "creating",
				states: { creating: "active", starting: "pending", running: "pending" },
			},
			{
				status: "starting",
				runtime: "openclaw",
				title: "Setting up OpenClaw",
				activeLabel: "Installing and starting OpenClaw",
				activeDescription:
					"Booting the environment, installing Clawdi and the agent runtime, then checking readiness.",
				step: "Step 2 of 3",
				currentStage: "starting",
				states: { creating: "completed", starting: "active", running: "pending" },
			},
			{
				status: "running",
				runtime: "hermes",
				title: "Setting up Hermes",
				activeLabel: "Ready",
				activeDescription: "Setup is complete.",
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
					deploymentTransitionEscalated: false,
					isCheckingDeployment: false,
					onCheckDeploymentAgain: () => undefined,
				}),
			);

			expect(markup).toContain(fixture.title);
			expect(markup).not.toContain("Deploying your agent");
			expect(markup).not.toContain("Current status");
			expect(markup).toContain(fixture.activeLabel);
			expect(markup).toContain(fixture.activeDescription);
			expect(markup).toContain(fixture.step);
			expect(markup).toContain('aria-label="Deployment progress"');
			for (const [stage, state] of Object.entries(fixture.states)) {
				expect(markup).toMatch(
					new RegExp(
						`data-deployment-stage="${stage}" data-stage-state="${state}"${stage === fixture.currentStage ? ' aria-current="step"' : ""}`,
					),
				);
			}
			for (const shortLabel of ["Cloud resources", "Agent software", "Ready"])
				expect(markup).toContain(`>${shortLabel}</p>`);
			expect(markup).toContain("updates automatically");
			expect(markup).toContain("7–10 minutes");
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
				deploymentTransitionEscalated: false,
				isCheckingDeployment: false,
				onCheckDeploymentAgain: () => undefined,
			}),
		);

		expect(markup).toContain('role="alert"');
		expect(markup).toContain("Setup is taking longer than expected");
		expect(markup).toContain("Check again");
		expect(markup).not.toContain("Current status");
		expect(markup).toContain(">Installing and starting OpenClaw</p>");
		expect(markup).toContain("Step 2 of 3");
		expect(markup).toContain('data-deployment-stage="starting" data-stage-state="active"');
		expect(markup).not.toContain('data-slot="spinner"');
	});

	test("keeps deployment progress on the agent surface after its env identity is projected", () => {
		if (!shouldShowInitialDeploymentProgress) throw new Error("agent detail was not loaded");
		for (const status of ["creating", "starting"] as const) {
			const deployment = hostedDeploymentFixture({
				status,
				cloudEnvironments: { openclaw: "11111111-1111-4111-8111-111111111111" },
			});
			expect(
				shouldShowInitialDeploymentProgress(
					deploymentStatusFromResource(deployment.resource.status),
					null,
				),
			).toBe(true);
		}
	});

	test("renders a create failure in the setup panel without exposing internal details", () => {
		if (
			!initialDeploymentPage ||
			!shouldShowInitialDeploymentProgress ||
			!canRetryInitialDeployment
		) {
			throw new Error("agent detail was not loaded");
		}
		const deployment = hostedDeploymentFixture({
			id: "hdep_create_failed",
			status: "failed",
			acceptedOperation: failedOperation("create"),
		});
		const failure = deploymentFailurePresentation(deployment);
		if (!failure) throw new Error("Expected create failure presentation");
		const nonRetryableFailure = { ...failure, retryable: false };
		expect(canRetryInitialDeployment(failure)).toBe(true);
		expect(canRetryInitialDeployment(nonRetryableFailure)).toBe(false);
		expect(
			shouldShowInitialDeploymentProgress(
				deploymentStatusFromResource(deployment.resource.status),
				failure,
			),
		).toBe(true);

		const markup = renderToStaticMarkup(
			createElement(initialDeploymentPage, {
				deployment,
				failure: nonRetryableFailure,
				deploymentTransitionTimedOut: false,
				deploymentTransitionEscalated: false,
				isCheckingDeployment: false,
				onCheckDeploymentAgain: () => undefined,
			}),
		);

		expect(markup).toContain("Agent setup failed");
		expect(markup).not.toContain("Retry startup");
		expect(markup).toContain("The Clawdi service could not complete this request.");
		expect(markup).not.toContain("Internal operation failure");
		expect(markup).not.toContain("Contact support");
	});

	test("keeps projection availability notices off the deployment-backed overview", () => {
		if (!shouldShowProjectionNotice) throw new Error("agent detail was not loaded");

		expect(shouldShowProjectionNotice("overview")).toBe(false);
		expect(shouldShowProjectionNotice("console")).toBe(false);
		expect(shouldShowProjectionNotice("terminal")).toBe(false);
		expect(shouldShowProjectionNotice("ai")).toBe(false);
		expect(shouldShowProjectionNotice("settings")).toBe(false);
		expect(shouldShowProjectionNotice("sessions")).toBe(false);
		expect(shouldShowProjectionNotice("projects")).toBe(true);
		expect(shouldShowProjectionNotice("skills")).toBe(false);
		expect(shouldShowProjectionNotice("vaults")).toBe(false);
	});

	test("keeps lifecycle actions out of the deployment-backed overview", () => {
		const detailSource = readFileSync(
			new URL("./hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		const overviewStatusSource = detailSource.slice(
			detailSource.indexOf("export function OverviewComputeStatus"),
			detailSource.indexOf("export function OverviewComputeSummary"),
		);
		expect(overviewStatusSource).not.toContain("StartComputeAction");
		expect(overviewStatusSource).not.toContain("RestartComputeAction");
		expect(overviewStatusSource).not.toContain("DeleteComputeAction");
		expect(overviewStatusSource).not.toContain("<Button");
		expect(overviewStatusSource).not.toContain("href=");
		expect(detailSource).not.toContain("OverviewFailureAction");
		expect(detailSource).toContain("shouldShowInitialDeploymentProgress(");
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
		expect(manualHandler).not.toContain("mutate");
		expect(manualHandler).not.toContain("restart");
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

	test("escalates a stuck transition on every timed-out surface with a cancel action", () => {
		const detailSource = readFileSync(
			new URL("./hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		const overviewStatusSource = detailSource.slice(
			detailSource.indexOf("export function OverviewComputeStatus"),
			detailSource.indexOf("export function OverviewComputeSummary"),
		);
		const initialPageSource = detailSource.slice(
			detailSource.indexOf("export function InitialDeploymentPage"),
			detailSource.indexOf("function OverviewTab"),
		);
		const consoleTabSource = detailSource.slice(
			detailSource.indexOf("function ConsoleTab"),
			detailSource.indexOf("function FilesTab"),
		);

		for (const source of [overviewStatusSource, initialPageSource, consoleTabSource]) {
			expect(source).toContain("appears to be stuck");
			expect(source).toContain("<DeploymentCancelAction");
			expect(source).toContain("taking longer than expected");
		}
		expect(initialPageSource).toContain("Setup appears to be stuck");
	});

	test("gates the cancel action behind the backend cancel acceptance contract", () => {
		const actionSource = readFileSync(
			new URL("./deployment-cancel-action.tsx", import.meta.url),
			"utf8",
		);
		expect(actionSource).toContain("canCancelOperation(operation)");
		expect(actionSource).toContain("Cancel this change");
		expect(actionSource).toContain('data-hosted="true"');
		const statusSource = readFileSync(new URL("../deployment-status.ts", import.meta.url), "utf8");
		expect(statusSource).toContain('verb !== "migrate_image"');
		expect(statusSource).toContain('verb !== "rollback_image"');
	});

	test("keeps the escalation honest as a stuck state, not a warning badge for running compute", () => {
		if (!overviewComputeStatus) throw new Error("agent detail was not loaded");
		const markup = renderToStaticMarkup(
			createElement(overviewComputeStatus, {
				deployment: hostedDeploymentFixture({ status: "running" }),
				failure: null,
				deploymentTransitionTimedOut: false,
				deploymentTransitionEscalated: false,
			}),
		);

		expect(markup).not.toContain("appears to be stuck");
		expect(markup).not.toContain("<button");
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
		expect(detailSource).toContain('<RuntimeUiCredentialRow label="Username"');
		expect(detailSource).toContain('label="Password"');
		expect(detailSource).not.toContain('<RuntimeUiCredentialRow label="Token"');
		expect(detailSource).toContain("Reconnect");
		expect(detailSource).toContain("Sign in to Hermes");
		expect(detailSource).toContain("Get your Hermes username and password from Access.");
		expect(detailSource).toContain("clawdi.hermes-access-hint.dismissed");
		expect(detailSource).toContain('runtime === "hermes" ? (');
		expect(detailSource).not.toContain("Open Access to retry");
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

function failedOperation(verb: DeploymentOperationVerb): DeploymentOperation {
	return {
		...acceptedOperation(verb),
		done: true,
		error: {
			code: 13,
			message: "operation failed",
			details: [
				{
					"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails",
					type: "https://api.clawdi.ai/problems/operation-failed",
					title: "Operation failed",
					status: 500,
					detail: "Internal operation failure",
					code: "operation_failed",
					retryable: true,
					conditionReason: "OperationFailed",
					conditionMessage: "Internal operation failure",
					observedGeneration: 2,
				},
			],
		},
		response: null,
	};
}

function successfulOperation(
	verb: DeploymentOperationVerb,
	deployment: HostedDeployment,
): DeploymentOperation {
	return {
		...acceptedOperation(verb),
		done: true,
		response: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
			deployment: deployment.resource,
		},
	};
}

describe("deployment mutation settlement", () => {
	test("keeps subscription assignment inventories scoped to delete snapshot invalidation", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(billingKeys.deployments, []);
		queryClient.setQueryData(["get", "/v1/agents"], []);
		queryClient.setQueryData(billingKeys.subscriptions, []);
		queryClient.setQueryData(billingKeys.reusableSubscriptions, []);

		if (!invalidateSnapshots || !invalidateDeleteSnapshots) {
			throw new Error("deployment hooks were not loaded");
		}
		invalidateSnapshots(queryClient);

		expect(queryClient.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(["get", "/v1/agents"])?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(billingKeys.subscriptions)?.isInvalidated).toBe(false);
		expect(queryClient.getQueryState(billingKeys.reusableSubscriptions)?.isInvalidated).toBe(false);

		invalidateDeleteSnapshots(queryClient);
		expect(queryClient.getQueryState(billingKeys.subscriptions)?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(billingKeys.reusableSubscriptions)?.isInvalidated).toBe(true);
	});

	test("uses the shared invalidation on every inventory-changing mutation settlement", () => {
		const source = readFileSync(new URL("./deployment-hooks.ts", import.meta.url), "utf8");
		const settlementInvalidations = source.match(
			/onSettled: \(\) => invalidateDeploymentSnapshots\(qc\)/g,
		);

		// Declarative lifecycle, access reset, delete, settings updates, and
		// operation cancellation all reconcile even when the request rejects
		// or times out.
		expect(settlementInvalidations).toHaveLength(5);
	});

	test("waits for accepted navigation before projecting the delete transition", async () => {
		if (!settleAcceptedDelete) throw new Error("deployment hooks were not loaded");
		const queryClient = new QueryClient();
		queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, [
			hostedDeploymentFixture({ id: "hdep_delete" }),
		]);
		const navigation = Promise.withResolvers<void>();
		let navigationStarts = 0;

		const settlement = settleAcceptedDelete(
			queryClient,
			{ deploymentId: "hdep_delete", operation: acceptedOperation("delete") },
			() => {
				navigationStarts += 1;
				return navigation.promise;
			},
			() => undefined,
		);

		expect(navigationStarts).toBe(1);
		const beforeNavigation = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);
		expect(requiredDeploymentStatus(beforeNavigation?.[0]).summary_state).not.toBe("deleting");

		navigation.resolve();
		expect(await settlement).toBe(true);

		const projected = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);
		expect(requiredDeploymentStatus(projected?.[0]).summary_state).toBe("deleting");
		expect(navigationStarts).toBe(1);
	});

	test("settles an accepted delete when navigation fails", async () => {
		if (!settleAcceptedDelete) throw new Error("deployment hooks were not loaded");
		const queryClient = new QueryClient();
		queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, [
			hostedDeploymentFixture({ id: "hdep_delete" }),
		]);
		const navigation = Promise.withResolvers<void>();
		let navigationStarts = 0;

		const settlement = settleAcceptedDelete(
			queryClient,
			{ deploymentId: "hdep_delete", operation: acceptedOperation("delete") },
			() => {
				navigationStarts += 1;
				return navigation.promise;
			},
			() => undefined,
		);

		expect(navigationStarts).toBe(1);
		const beforeFailure = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);
		expect(requiredDeploymentStatus(beforeFailure?.[0]).summary_state).not.toBe("deleting");

		navigation.reject(new Error("navigation failed"));
		expect(await settlement).toBe(false);

		const projected = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);
		expect(requiredDeploymentStatus(projected?.[0]).summary_state).toBe("deleting");
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
