import type { DeploymentRead } from "../api";
import { runtimeBrowserUiLabel } from "./agent-overview";
import { deploymentFailurePresentation } from "./deployment-failure";
import { deploymentStatusFromResource } from "./deployment-status";

export const computeStatusDetailsCopy = {
	checking: "Clawdi is checking this agent.",
	failed: "The last change to this agent didn't complete.",
	stuck: "This change appears to be stuck. You can cancel it and try again.",
	cancel: "Cancel this change",
	cancelRequested: "Cancellation requested",
	cancelRequestedDescription: "The change will be stopped. This page updates automatically.",
	cancelFailed: "Couldn't cancel this change",
	restarting: "Restarting",
	slow: "This change is taking longer than expected.",
	updating: "Updating agent settings.",
	starting: "Startup is still in progress.",
	stopping: "Agent is stopping.",
	stopped: (runtime: string | null | undefined) =>
		`Agent is stopped. Channels and ${runtimeBrowserUiLabel(runtime)} are unavailable.`,
	deleting: "Agent is being deleted.",
	deleted: "Agent was deleted.",
	unknown: "Clawdi can't confirm this agent's status.",
} as const;

/**
 * Web's ComputeStatusDetails, in its order. `cancel` marks the stuck state, which offers
 * "Cancel this change".
 */
export function computeStatusDetailsPresentation(
	deployment: DeploymentRead,
	{ timedOut, escalated }: { timedOut: boolean; escalated: boolean },
) {
	const failure = deploymentFailurePresentation(deployment);
	const status = deploymentStatusFromResource(deployment.resource.status);
	const line = (description: string, tone: "destructive" | "warning" | "neutral", cancel = false) =>
		({ title: null, description, tone, cancel }) as const;
	// Storage full is the one runtime-unavailable state the owner can fix.
	if (failure?.status.kind === "runtime_unavailable" && failure.code !== "storage_full")
		return line(computeStatusDetailsCopy.checking, "warning");
	if (failure)
		return {
			title: failure.title,
			description: failure.reason,
			tone: failure.status.tone === "warning" ? ("warning" as const) : ("destructive" as const),
			cancel: false,
		};
	if (status.kind === "failed") return line(computeStatusDetailsCopy.failed, "destructive");
	if (escalated) return line(computeStatusDetailsCopy.stuck, "warning", true);
	if (status.kind === "restarting") return line(computeStatusDetailsCopy.restarting, "neutral");
	if (timedOut) return line(computeStatusDetailsCopy.slow, "warning");
	switch (status.kind) {
		case "updating":
			return line(computeStatusDetailsCopy.updating, "neutral");
		case "creating":
		case "starting":
			return line(computeStatusDetailsCopy.starting, "neutral");
		case "stopping":
			return line(computeStatusDetailsCopy.stopping, "neutral");
		case "stopped":
			return line(computeStatusDetailsCopy.stopped(deployment.resource.spec.runtime), "neutral");
		case "deleting":
			return line(computeStatusDetailsCopy.deleting, "neutral");
		case "deleted":
			return line(computeStatusDetailsCopy.deleted, "neutral");
		case "unknown":
			return line(computeStatusDetailsCopy.unknown, "warning");
		default:
			return null;
	}
}
