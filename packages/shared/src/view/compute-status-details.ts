import type { DeploymentRead } from "../api";
import { runtimeBrowserUiLabel } from "./agent-overview";
import { deploymentFailurePresentation } from "./deployment-failure";
import { deploymentStatusFromResource } from "./deployment-status";

export const computeStatusDetailsCopy = {
	checking: "Clawdi is checking this agent.",
	failed: "The last change to this agent didn't complete.",
	stuck: "This change appears to be stuck. You can cancel it and try again.",
	restarting: "Restarting",
	slow: "This change is taking longer than expected.",
	updating: "Updating agent settings.",
	starting: "Startup is still in progress.",
	stopping: "Agent is stopping.",
	deleting: "Agent is being deleted.",
	deleted: "Agent was deleted.",
	unknown: "Clawdi can't confirm this agent's status.",
} as const;

export function computeStatusDetailsPresentation(deployment: DeploymentRead) {
	const failure = deploymentFailurePresentation(deployment);
	const status = deploymentStatusFromResource(deployment.resource.status);
	if (failure?.status.kind === "runtime_unavailable")
		return {
			title: null,
			description: computeStatusDetailsCopy.checking,
			tone: "warning" as const,
		};
	if (failure)
		return { title: failure.title, description: failure.reason, tone: "destructive" as const };
	const descriptions = {
		creating: computeStatusDetailsCopy.starting,
		starting: computeStatusDetailsCopy.starting,
		failed: computeStatusDetailsCopy.failed,
		restarting: computeStatusDetailsCopy.restarting,
		updating: computeStatusDetailsCopy.updating,
		stopping: computeStatusDetailsCopy.stopping,
		deleting: computeStatusDetailsCopy.deleting,
		deleted: computeStatusDetailsCopy.deleted,
		unknown: computeStatusDetailsCopy.unknown,
	};
	const description =
		status.kind === "stopped"
			? `Agent is stopped. Channels and ${runtimeBrowserUiLabel(deployment.resource.spec.runtime)} are unavailable.`
			: status.kind in descriptions
				? descriptions[status.kind as keyof typeof descriptions]
				: null;
	return description
		? {
				title: null,
				description,
				tone:
					status.kind === "failed"
						? ("destructive" as const)
						: status.kind === "unknown"
							? ("warning" as const)
							: ("neutral" as const),
			}
		: null;
}
