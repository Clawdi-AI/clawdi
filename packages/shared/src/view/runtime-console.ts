import type { DeploymentRead } from "../api";
import { runtimeBrowserUiLabel } from "./agent-overview";
import { computeSubscriptionRequiredToStart } from "./compute-dunning";
import {
	deploymentStatusFromResource,
	deploymentStatusLabel,
	isRunningStatus,
} from "./deployment-status";
import { runtimeDisplayName } from "./hosted-runtime";
import { deploymentRuntimeUiIsReady, deploymentRuntimeUiWithdrawn } from "./runtime-ui-readiness";

export const RUNTIME_UI_WITHDRAWN_DESCRIPTION =
	"Your agent keeps running. Chat with it through channels, or use Terminal.";
export const runtimeConsoleCopy = {
	check: "Check again",
	terminalNow: "Use Terminal now",
	terminal: "Use Terminal",
	channels: "Open channels",
} as const;

export function runtimeConsolePresentation(
	deployment: DeploymentRead,
	timedOut: boolean,
	escalated: boolean,
) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const label = runtimeDisplayName(deployment.resource.spec.runtime);
	const browserLabel = runtimeBrowserUiLabel(deployment.resource.spec.runtime);
	const starting = status.kind === "creating" || status.kind === "starting";
	return {
		browserLabel,
		notRunningTitle: escalated
			? "Your agent’s setup appears to be stuck"
			: timedOut
				? "Your agent is taking longer than expected"
				: starting
					? "Starting your agent…"
					: "Agent is not running",
		notRunningDescription: escalated
			? "This change is still in progress. You can cancel it and try again."
			: timedOut
				? "This change is still in progress. Check again now or keep waiting."
				: starting
					? `${browserLabel} will open here when ready.`
					: `Start the agent to open the live ${browserLabel}. Current status: ${deploymentStatusLabel(status).toLowerCase()}.`,
		withdrawnTitle: `${browserLabel} is unavailable`,
		pendingTitle: `${browserLabel} isn’t ready yet`,
		pendingDescription: `Your agent is running. Check again in a moment, or use Terminal now while ${label} starts its browser interface.`,
		state:
			status.kind === "stopped"
				? "stopped"
				: status.kind !== "running"
					? "not_running"
					: deploymentRuntimeUiWithdrawn(deployment.resource.status)
						? "withdrawn"
						: deploymentRuntimeUiIsReady(deployment)
							? "ready"
							: "pending",
	};
}

export function stoppedAgentDescription(deployment: DeploymentRead) {
	return computeSubscriptionRequiredToStart(deployment)
		? "This agent is stopped. Choose a subscription to start it. Your saved data is kept."
		: deployment.start_action === "start"
			? "This agent is stopped. Start it to use its tools again."
			: "This agent is stopped. Your saved data is kept.";
}

/** Web FilesTab states; only the running state hosts the Files browser. */
export function agentFilesPresentation(deployment: DeploymentRead) {
	const status = deploymentStatusFromResource(deployment.resource.status);
	if (status.kind === "stopped")
		return {
			state: "stopped",
			title: "Stopped",
			description: stoppedAgentDescription(deployment),
		} as const;
	if (isRunningStatus(status)) return { state: "running" } as const;
	return status.kind === "creating" || status.kind === "starting"
		? ({
				state: "starting",
				title: "Starting your agent…",
				description:
					"Files opens once your agent and its private workspace service are ready. This page updates automatically.",
			} as const)
		: ({
				state: "not_running",
				title: "Agent is not running",
				description: `Start the agent to browse its workspace. Current status: ${deploymentStatusLabel(status).toLowerCase()}.`,
			} as const);
}
