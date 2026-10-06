import type { DeploymentFailurePresentation } from "./deployment-failure";
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

export const initialDeploymentCopy = {
	failureTitle: "Agent setup failed",
	failureDescription: "Setup stopped before this agent became ready.",
	retry: "Retry startup",
	check: "Check again",
	progress: "Setup progress",
} as const;

export function initialDeploymentPresentation(
	status: DeploymentStatus,
	runtimeLabel: string,
	timedOut: boolean,
	escalated: boolean,
) {
	const stages = [
		{ status: "creating", label: "Cloud resources" },
		{ status: "starting", label: "Agent software" },
		{ status: "running", label: "Ready" },
	] as const;
	const activeStageIndex = status.kind === "starting" ? 1 : status.kind === "running" ? 2 : 0;
	const activeStage =
		activeStageIndex === 0
			? {
					label: "Preparing cloud resources",
					description: "Creating a private environment and connecting your AI provider.",
				}
			: activeStageIndex === 1
				? {
						label: `Installing and starting ${runtimeLabel}`,
						description:
							"Provisioning a private workspace, installing the agent, and confirming readiness.",
					}
				: { label: "Ready", description: "Setup is complete." };
	return {
		title: escalated
			? "Setup appears to be stuck"
			: timedOut
				? "Setup is taking longer than expected"
				: `Setting up ${runtimeLabel}`,
		description: escalated
			? "We’ll keep checking automatically. If you want, cancel this setup and try again."
			: timedOut
				? "Your agent may still be starting. We’ll keep checking automatically."
				: "Setup usually takes about 7–10 minutes. It continues if you leave, and this page updates automatically while open.",
		activeStage,
		activeStageIndex,
		step: `Step ${activeStageIndex + 1} of ${stages.length}`,
		stages: stages.map((stage, index) => ({
			...stage,
			state:
				status.kind === "running" || index < activeStageIndex
					? "completed"
					: index === activeStageIndex
						? "active"
						: "pending",
		})),
	};
}
