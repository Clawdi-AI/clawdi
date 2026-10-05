import type { DeploymentRead } from "../api";
import { runtimeBrowserUiLabel } from "./agent-overview";
import { deploymentFailurePresentation } from "./deployment-failure";
import { deploymentStatusFromResource } from "./deployment-status";

export const computeStatusDetailsCopy = {
	checking: "Clawdi is checking this agent.",
	failed: "The last compute change did not complete.",
	stuck: "This change appears to be stuck. You can cancel it and try again.",
	restarting: "Restarting",
	slow: "This compute change is taking longer than expected.",
	updating: "Updating compute settings.",
	starting: "Startup is still in progress.",
	stopping: "Compute is stopping.",
	deleting: "Compute is being removed.",
	deleted: "Compute is no longer available.",
	unknown: "Clawdi cannot confirm the current compute status.",
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
	const description =
		status.kind === "stopped"
			? `Compute is stopped. Channels and ${runtimeBrowserUiLabel(deployment.resource.spec.runtime)} are unavailable.`
			: status.kind === "failed"
				? computeStatusDetailsCopy.failed
				: status.kind === "restarting"
					? computeStatusDetailsCopy.restarting
					: status.kind === "updating"
						? computeStatusDetailsCopy.updating
						: status.kind === "creating" || status.kind === "starting"
							? computeStatusDetailsCopy.starting
							: status.kind === "stopping"
								? computeStatusDetailsCopy.stopping
								: status.kind === "deleting"
									? computeStatusDetailsCopy.deleting
									: status.kind === "deleted"
										? computeStatusDetailsCopy.deleted
										: status.kind === "unknown"
											? computeStatusDetailsCopy.unknown
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
