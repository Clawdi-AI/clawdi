import type { DeploymentFailurePresentation } from "./deployment-failure";
import type { ProvisioningPath } from "./deployment-polling";
import type { DeploymentStatus } from "./deployment-status";

export function shouldShowInitialDeploymentProgress(
	status: DeploymentStatus,
	failure: DeploymentFailurePresentation | null,
): boolean {
	return (
		((status.kind === "creating" || status.kind === "starting") && failure === null) ||
		failure?.failedVerb === "create"
	);
}

export function canRetryInitialDeployment(failure: DeploymentFailurePresentation): boolean {
	return failure.retryable !== false && failure.remediation.kind === "restart";
}

/**
 * Agent sections that stay usable while the first start is in progress: the setup
 * screen itself and account-wide data that never touches the runtime. Every other
 * section needs a running runtime and is disabled until it is ready.
 */
export const AGENT_SECTIONS_AVAILABLE_DURING_SETUP = [
	"overview",
	"memories",
	"connectors",
] as const;

export function agentSectionAvailableDuringSetup(section: string): boolean {
	return AGENT_SECTIONS_AVAILABLE_DURING_SETUP.some((candidate) => candidate === section);
}

export const initialDeploymentCopy = {
	failureTitle: "Agent setup failed",
	retry: "Retry startup",
	contactSupport: "Contact support",
	ready: "Your agent is ready.",
	elapsed: "Elapsed",
	unavailableUntilReady: "Available when your agent is ready",
} as const;

/** How long the completed state stays readable before the overview is revealed. */
export const INITIAL_DEPLOYMENT_COMPLETE_PAUSE_MS = 1_100;

/** Length of the single reveal from the setup status into the agent overview. */
export const INITIAL_DEPLOYMENT_REVEAL_MS = 900;

export type InitialDeploymentTone = "progress" | "delayed" | "stuck" | "ready";

/**
 * Presents the first-start wait as one status line: starting (or setting up on the
 * standard path) until chat on the web is usable, then ready. Publishing the chat
 * surface after the runtime runs is an internal step and keeps the same line. The
 * provisioning path selects the honest expectation shown beside the elapsed time.
 */
export function initialDeploymentPresentation(
	status: DeploymentStatus,
	timedOut: boolean,
	escalated: boolean,
	provisioningPath: ProvisioningPath,
	/** Running, but chat on the web is not usable yet. */
	awaitingChat = false,
): {
	tone: InitialDeploymentTone;
	title: string;
	/** Typical duration, shown with the elapsed time while setup is on track. */
	expectation: string | null;
} {
	const tone: InitialDeploymentTone =
		status.kind === "running" && !awaitingChat
			? "ready"
			: escalated
				? "stuck"
				: timedOut
					? "delayed"
					: "progress";
	const warm = provisioningPath === "warm";
	return {
		tone,
		title:
			tone === "ready"
				? "Your agent is ready"
				: tone === "stuck"
					? "Setup appears to be stuck"
					: tone === "delayed"
						? "Setup is taking longer than expected"
						: warm
							? "Starting your agent…"
							: "Setting up your agent…",
		expectation:
			tone !== "progress" ? null : warm ? "Usually under a minute" : "Usually 3–5 minutes",
	};
}

/** Start of the accepted create operation, used for the honest elapsed timer. */
export function initialDeploymentStartedAtMs(
	operation:
		| {
				metadata: { verb: string; createTime?: string | null };
		  }
		| null
		| undefined,
): number | null {
	if (operation?.metadata.verb !== "create") return null;
	const startedAtMs = Date.parse(operation.metadata.createTime ?? "");
	return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

/** Stopwatch-style elapsed time: `0:07`, `4:32`, `1:02:09`. */
export function formatElapsedClock(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = String(totalSeconds % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
		: `${minutes}:${seconds}`;
}
