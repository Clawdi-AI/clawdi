import { describe, expect, test } from "bun:test";
import type { HostedDeployOperation } from "@clawdi/shared/api";
import { initialDeploymentCircleStops } from "@clawdi/shared/ui";
import {
	agentSectionAvailableDuringSetup,
	DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS,
	DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
	DEPLOYMENT_TRANSITION_ESCALATION_MS,
	DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
	DEPLOYMENT_WARM_CREATION_ESCALATION_MS,
	DEPLOYMENT_WARM_CREATION_TRANSITION_TIMEOUT_MS,
	deploymentPollingState,
	deploymentProvisioningPath,
	deploymentRuntimeUiIsReady,
	deploymentToTiles,
	deploymentWebChatIsUsable,
	formatElapsedClock,
	hostedDeploymentSetupInProgress,
	initialDeploymentPresentation,
	initialDeploymentStartedAtMs,
	initialDeploymentSupportContext,
	initialDeploymentSupportMailto,
	parseDeploymentStatus,
} from "@clawdi/shared/view";
import { hostedDeploymentFixture } from "./hosted-deployment.test-fixture";

const ACCEPTED_AT = "2026-10-07T05:00:00Z";
const acceptedAtMs = Date.parse(ACCEPTED_AT);

function operation(verb: HostedDeployOperation["metadata"]["verb"]): HostedDeployOperation {
	return {
		name: `operations/${verb}-wait`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_wait",
			verb,
			targetGeneration: 1,
			manifestETag: "manifest-wait",
			createTime: ACCEPTED_AT,
			updateTime: ACCEPTED_AT,
		},
		done: false,
		response: null,
	};
}

function transitionAt(
	path: "warm" | "standard",
	elapsedMs: number,
	verb: HostedDeployOperation["metadata"]["verb"] = "create",
) {
	const deployment = hostedDeploymentFixture({
		id: "hdep_wait",
		status: verb === "create" ? "starting" : "restarting",
		provisioningPath: path,
		acceptedOperation: operation(verb),
	});
	const state = deploymentPollingState([deployment], new Map(), acceptedAtMs + elapsedMs);
	return { kind: state.transitions.get("hdep_wait")?.kind, interval: state.refetchInterval };
}

describe("initial deployment presentation", () => {
	const view = (
		raw: string,
		path: "warm" | "standard",
		{ timedOut = false, escalated = false, awaitingChat = false } = {},
	) =>
		initialDeploymentPresentation(
			parseDeploymentStatus(raw),
			timedOut,
			escalated,
			path,
			awaitingChat,
		);

	test("one status line stays on starting until chat on the web is usable", () => {
		expect(view("creating", "warm")).toEqual({
			tone: "progress",
			title: "Starting your agent…",
			expectation: "Usually under a minute",
		});
		expect(view("starting", "standard")).toEqual({
			tone: "progress",
			title: "Setting up your agent…",
			expectation: "Usually 3–5 minutes",
		});
		for (const path of ["warm", "standard"] as const) {
			// Publishing chat after the runtime runs is internal; the line does not change.
			expect(view("running", path, { awaitingChat: true })).toEqual(
				view("starting", path === "warm" ? "warm" : "standard"),
			);
			expect(view("running", path)).toEqual({
				tone: "ready",
				title: "Your agent is ready",
				expectation: null,
			});
		}
	});

	test("timed out and escalated states replace the estimate on both paths", () => {
		for (const path of ["warm", "standard"] as const) {
			const delayed = view("starting", path, { timedOut: true });
			const stuck = view("running", path, { timedOut: true, escalated: true, awaitingChat: true });
			expect(delayed.tone).toBe("delayed");
			expect(delayed.title).toBe("Setup is taking longer than expected");
			expect(delayed.expectation).toBeNull();
			expect(stuck.tone).toBe("stuck");
			expect(stuck.title).toBe("Setup appears to be stuck");
			expect(stuck.expectation).toBeNull();
		}
	});
});

describe("agent sections during setup", () => {
	const chat = {
		runtime: "openclaw",
		role: "control_ui",
		url: "https://runtime.example/",
		auth_mode: "openclaw_token",
		browser_mode: "embedded_and_top_level",
		component_readiness: 1,
		serving_ready: true,
		serving_reason: "Ok",
	} as const;
	const deployment = (
		status: "creating" | "starting" | "running",
		verb: HostedDeployOperation["metadata"]["verb"] = "create",
		options: { chatPublished?: boolean; acceptedOperation?: HostedDeployOperation } = {},
	) =>
		hostedDeploymentFixture({
			id: "hdep_wait",
			status,
			provisioningPath: "warm",
			acceptedOperation: options.acceptedOperation ?? operation(verb),
			runtimeUiEndpoint: options.chatPublished ? chat : null,
		});

	test("only the first start gates the runtime sections", () => {
		expect(hostedDeploymentSetupInProgress(deployment("creating"))).toBe(true);
		expect(hostedDeploymentSetupInProgress(deployment("starting"))).toBe(true);
		// Starting an existing agent again is not a first setup.
		expect(hostedDeploymentSetupInProgress(deployment("starting", "start"))).toBe(false);
	});

	test("setup ends only when the web chat surface is published", () => {
		const running = deployment("running");
		expect(deploymentRuntimeUiIsReady(running)).toBe(false);
		expect(hostedDeploymentSetupInProgress(running, acceptedAtMs + 60_000)).toBe(true);
		const usable = deployment("running", "create", { chatPublished: true });
		expect(deploymentRuntimeUiIsReady(usable)).toBe(true);
		expect(hostedDeploymentSetupInProgress(usable, acceptedAtMs + 60_000)).toBe(false);
	});

	test("setup waits for Hosted serving readiness on the published chat", () => {
		const published = deployment("running", "create", { chatPublished: true });
		expect(deploymentWebChatIsUsable(published)).toBe(true);
		const notServing = { ...chat, serving_ready: false, serving_reason: "HttpStatus" } as const;
		const withField = hostedDeploymentFixture({
			id: "hdep_wait",
			status: "running",
			provisioningPath: "warm",
			acceptedOperation: operation("create"),
			runtimeUiEndpoint: notServing,
		});
		expect(deploymentRuntimeUiIsReady(withField)).toBe(true);
		expect(deploymentWebChatIsUsable(withField)).toBe(false);
		expect(hostedDeploymentSetupInProgress(withField, acceptedAtMs + 60_000)).toBe(true);
	});

	test("an older agent whose chat is unavailable is not in setup again", () => {
		const finished = {
			...operation("create"),
			done: true,
			metadata: { ...operation("create").metadata, updateTime: ACCEPTED_AT },
		};
		const running = deployment("running", "create", { acceptedOperation: finished });
		expect(hostedDeploymentSetupInProgress(running, acceptedAtMs + 60_000)).toBe(true);
		expect(hostedDeploymentSetupInProgress(running, acceptedAtMs + 16 * 60_000)).toBe(false);
		expect(hostedDeploymentSetupInProgress(deployment("running", "start"), acceptedAtMs)).toBe(
			false,
		);
	});

	test("opening chat polls on its own publication window", () => {
		const opening = deployment("running");
		const state = deploymentPollingState([opening], new Map(), acceptedAtMs + 3 * 60_000);
		expect(state.transitions.get("hdep_wait")?.kind).toBe("converging");
		expect(state.refetchInterval).toBe(DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS);
	});

	test("keeps the setup screen and shared account data available", () => {
		expect(["overview", "memories", "connectors"].every(agentSectionAvailableDuringSetup)).toBe(
			true,
		);
		for (const section of [
			"console",
			"channels",
			"ai",
			"sessions",
			"projects",
			"plugins",
			"skills",
			"vaults",
			"files",
			"terminal",
			"settings",
		])
			expect(agentSectionAvailableDuringSetup(section)).toBe(false);
	});

	test("hosted tiles carry the setup state for agent navigation", () => {
		const [starting] = deploymentToTiles(deployment("starting"), new Map());
		const [running] = deploymentToTiles(
			deployment("running", "create", { chatPublished: true }),
			new Map(),
		);
		expect(starting?.setupInProgress).toBe(true);
		expect(running?.setupInProgress).toBe(false);
	});
});

describe("initial deployment timer", () => {
	test("starts from the accepted create operation only", () => {
		expect(initialDeploymentStartedAtMs(operation("create"))).toBe(acceptedAtMs);
		expect(initialDeploymentStartedAtMs(operation("restart"))).toBeNull();
		expect(initialDeploymentStartedAtMs(null)).toBeNull();
	});

	test("formats elapsed time like a stopwatch", () => {
		expect(formatElapsedClock(-5_000)).toBe("0:00");
		expect(formatElapsedClock(14_900)).toBe("0:14");
		expect(formatElapsedClock(272_000)).toBe("4:32");
		expect(formatElapsedClock(3_729_000)).toBe("1:02:09");
	});
});

describe("initial deployment thresholds", () => {
	test("treats a missing hint from an older Hosted response as standard", () => {
		expect(deploymentProvisioningPath(hostedDeploymentFixture({ provisioningPath: "warm" }))).toBe(
			"warm",
		);
		expect(deploymentProvisioningPath({})).toBe("standard");
	});

	test("a warm create reports a delay after two minutes but keeps fast polling", () => {
		const justBefore = transitionAt("warm", DEPLOYMENT_WARM_CREATION_TRANSITION_TIMEOUT_MS - 1);
		const delayed = transitionAt("warm", DEPLOYMENT_WARM_CREATION_TRANSITION_TIMEOUT_MS);
		const escalated = transitionAt("warm", DEPLOYMENT_WARM_CREATION_ESCALATION_MS);

		expect(DEPLOYMENT_WARM_CREATION_TRANSITION_TIMEOUT_MS).toBe(2 * 60_000);
		expect(justBefore).toEqual({
			kind: "converging",
			interval: DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
		});
		expect(delayed).toEqual({
			kind: "timed_out",
			interval: DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
		});
		expect(escalated).toEqual({
			kind: "escalated",
			interval: DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
		});
	});

	test("a standard create keeps the longer measured window", () => {
		expect(transitionAt("standard", DEPLOYMENT_WARM_CREATION_TRANSITION_TIMEOUT_MS).kind).toBe(
			"converging",
		);
		expect(transitionAt("standard", DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS)).toEqual({
			kind: "timed_out",
			interval: DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
		});
		expect(transitionAt("standard", DEPLOYMENT_TRANSITION_ESCALATION_MS).kind).toBe("escalated");
	});

	test("the warm hint does not shorten later lifecycle changes", () => {
		expect(
			transitionAt("warm", DEPLOYMENT_WARM_CREATION_TRANSITION_TIMEOUT_MS, "restart").kind,
		).toBe("converging");
	});
});

describe("initial deployment support context", () => {
	test("carries deployment facts support needs and nothing about the person", () => {
		const deployment = hostedDeploymentFixture({
			id: "hdep_wait",
			status: "starting",
			runtime: "hermes",
			provisioningPath: "warm",
			acceptedOperation: operation("create"),
		});
		expect(initialDeploymentSupportContext(deployment, "stuck", acceptedAtMs + 754_900)).toEqual({
			setup_deployment_id: "hdep_wait",
			setup_runtime: "hermes",
			setup_provisioning_path: "warm",
			setup_status: "starting",
			setup_state: "stuck",
			setup_elapsed_seconds: 754,
			setup_reported_at: "2026-10-07T05:12:34.900Z",
		});
	});

	test("prefills an email with the same context when live chat is unavailable", () => {
		const deployment = hostedDeploymentFixture({ id: "hdep_wait", status: "creating" });
		const href = initialDeploymentSupportMailto(
			initialDeploymentSupportContext(deployment, "delayed", acceptedAtMs),
		);
		const url = new URL(href);
		expect(url.protocol).toBe("mailto:");
		expect(url.pathname).toBe("support@clawdi.ai");
		expect(url.searchParams.get("subject")).toBe("Agent setup help (hdep_wait)");
		expect(url.searchParams.get("body")).toContain("setup_status: creating");
		expect(url.searchParams.get("body")).toContain("setup_provisioning_path: standard");
	});
});

describe("initial deployment circle backdrop", () => {
	test("holds the center, then eases to transparent without a visible ring", () => {
		const stops = initialDeploymentCircleStops({ centerOpacity: 0.55, falloffStart: 0.45 });
		expect(stops[0]).toEqual({ offset: 0, opacity: 0.55 });
		expect(stops[1]).toEqual({ offset: 0.45, opacity: 0.55 });
		expect(stops.at(-1)).toEqual({ offset: 1, opacity: 0 });
		for (const [index, stop] of stops.entries()) {
			if (index === 0) continue;
			expect(stop.offset).toBeGreaterThan(stops[index - 1]?.offset ?? -1);
			expect(stop.opacity).toBeLessThanOrEqual(stops[index - 1]?.opacity ?? 1);
		}
		// Flat at both ends of the falloff: the first and last steps change little.
		expect(0.55 - (stops[2]?.opacity ?? 0)).toBeLessThan(0.02);
		expect(stops.at(-2)?.opacity ?? 1).toBeLessThan(0.02);
	});
});
