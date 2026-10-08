import type { DeploymentRead as HostedDeployment } from "../api";
import { deploymentFailurePresentation } from "./deployment-failure";
import { deploymentProvisioningPath } from "./deployment-polling";
import { deploymentStatusFromResource } from "./deployment-status";
import { initialDeploymentStartedAtMs } from "./initial-deployment";

export const SUPPORT_EMAIL = "support@clawdi.ai";

/** Chatwoot conversation label for first-start help; it must exist in the support account. */
export const INITIAL_DEPLOYMENT_SUPPORT_LABEL = "agent-setup";

export type InitialDeploymentSupportState = "delayed" | "stuck" | "failed";

/**
 * Operational facts support needs to look up a first start that is slow, stuck, or
 * failed. Only deployment metadata: identity comes from the signed-in support contact.
 */
export type InitialDeploymentSupportContext = {
	setup_deployment_id: string;
	setup_runtime: string;
	setup_provisioning_path: string;
	setup_status: string;
	setup_state: InitialDeploymentSupportState;
	setup_elapsed_seconds?: number;
	setup_failure_code?: string;
	setup_reported_at: string;
};

export function initialDeploymentSupportContext(
	deployment: HostedDeployment,
	state: InitialDeploymentSupportState,
	nowMs: number,
): InitialDeploymentSupportContext {
	const startedAtMs = initialDeploymentStartedAtMs(deployment.accepted_operation);
	const failureCode = deploymentFailurePresentation(deployment)?.code;
	return {
		setup_deployment_id: deployment.resource.id,
		setup_runtime: deployment.resource.spec.runtime,
		setup_provisioning_path: deploymentProvisioningPath(deployment),
		setup_status: deploymentStatusFromResource(deployment.resource.status).kind,
		setup_state: state,
		...(startedAtMs !== null
			? { setup_elapsed_seconds: Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)) }
			: {}),
		...(failureCode ? { setup_failure_code: failureCode } : {}),
		setup_reported_at: new Date(nowMs).toISOString(),
	};
}

/** Email fallback for clients without the live chat widget (RFC 6068 subject and body). */
export function initialDeploymentSupportMailto(context: InitialDeploymentSupportContext): string {
	const subject = `Agent setup help (${context.setup_deployment_id})`;
	const body = [
		"Please describe what you see, then send. Setup details:",
		"",
		...Object.entries(context).map(([key, value]) => `${key}: ${value}`),
	].join("\n");
	return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
