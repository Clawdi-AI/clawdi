import type { DeployComponents, DeploymentRead as HostedDeployment } from "../api";
import { hasCurrentRuntimeHealthDegradation } from "./deployment-status";

type HostedDeploymentStatus = DeployComponents["schemas"]["HostedDeploymentStatus"];
export const DEPLOYMENT_SERVING_ADVISORY_REASONS = [
	"ProviderConflict",
	"RuntimeUiUnavailable",
] as const;
export type DeploymentServingAdvisoryReason = (typeof DEPLOYMENT_SERVING_ADVISORY_REASONS)[number];

const SERVING_ADVISORY_REASON_SET = new Set<string>(DEPLOYMENT_SERVING_ADVISORY_REASONS);

function isServingAdvisoryReason(reason: string): reason is DeploymentServingAdvisoryReason {
	return SERVING_ADVISORY_REASON_SET.has(reason);
}

/** The current-generation serving advisory, if the controller projects one. */
export function currentServingAdvisory(
	status: HostedDeploymentStatus | null | undefined,
): DeploymentServingAdvisoryReason | null {
	if (!status) return null;
	for (const condition of status.conditions) {
		if (
			condition.type === "Degraded" &&
			condition.status === "True" &&
			condition.observedGeneration === status.observedGeneration &&
			isServingAdvisoryReason(condition.reason)
		) {
			return condition.reason;
		}
	}
	return null;
}

/** The runtime withdrew only its optional dashboard; the agent itself keeps serving. */
export function deploymentRuntimeUiWithdrawn(
	status: HostedDeploymentStatus | null | undefined,
): boolean {
	return currentServingAdvisory(status) === "RuntimeUiUnavailable";
}

export function deploymentRuntimeUiIsReady(deployment: HostedDeployment): boolean {
	const { metadata, spec, status } = deployment.resource;
	const generation = metadata.generation;
	const ready = status?.conditions.find((condition) => condition.type === "Ready");
	const componentReady = deployment.runtime_ui_endpoint?.component_readiness === 1;
	return Boolean(
		generation >= 1 &&
			spec.desired_lifecycle === "running" &&
			(status?.summary_state === "running" ||
				(componentReady && status?.summary_state === "failed")) &&
			!status.deleted_at &&
			status.observed_at &&
			status.observedGeneration === generation &&
			!deploymentRuntimeUiWithdrawn(status) &&
			status.driver_acknowledged_generation === generation &&
			status.driver_applied_generation === generation &&
			(componentReady ||
				(ready?.status === "True" &&
					ready.observedGeneration === generation &&
					!hasCurrentRuntimeHealthDegradation(status))) &&
			deployment.runtime_ui_endpoint?.runtime === spec.runtime &&
			deployment.runtime_ui_endpoint.role === "control_ui" &&
			deployment.runtime_ui_endpoint.url,
	);
}

/**
 * The single readiness gate for finishing a first start: chat on the web is usable.
 * Hosted's `serving_ready` covers the route, auth handoff, and public reachability.
 */
export function deploymentWebChatIsUsable(deployment: HostedDeployment): boolean {
	return (
		deployment.runtime_ui_endpoint?.serving_ready === true && deploymentRuntimeUiIsReady(deployment)
	);
}
