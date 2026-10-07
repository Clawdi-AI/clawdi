import { type DeploymentRead, deploymentLifecycleAvailable } from "../api";
import { deploymentStatusFromResource } from "./deployment-status";

export type StartComputeActionTarget =
	| "start"
	| "subscribe"
	| "top_up"
	| "fix_payment"
	| "contact_support";

/**
 * Web StartComputeAction: what the start control does for this deployment. `target` is null for
 * a disabled placeholder (subscription changes in flight or start unavailable).
 */
export function startComputeActionPresentation(
	deployment: Pick<DeploymentRead, "start_action" | "resource">,
	startLabel = "Start agent",
): { target: StartComputeActionTarget | null; label: string; enabled: boolean } {
	const canStart = deploymentLifecycleAvailable(
		"start",
		deploymentStatusFromResource(deployment.resource.status).kind,
	);
	switch (deployment.start_action) {
		case "subscribe":
			return { target: "subscribe", label: "Subscribe to start", enabled: canStart };
		case "top_up":
			return { target: "top_up", label: "Top up to start", enabled: canStart };
		case "fix_payment":
			return { target: "fix_payment", label: "Pay to start", enabled: canStart };
		case "contact_support":
			return { target: "contact_support", label: "Contact support", enabled: true };
		case "start":
			return { target: "start", label: startLabel, enabled: canStart };
		case "unavailable":
			return { target: null, label: "Start unavailable", enabled: false };
		default:
			return { target: null, label: "Updating subscription", enabled: false };
	}
}

export const SUPPORT_MAILTO = "mailto:support@clawdi.ai";
