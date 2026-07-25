import type { HostedDeployment } from "@/hosted/billing/contracts";
import type { DeploymentOperationVerb } from "@/hosted/deployment-status";

const DEFAULT_FAILURE_REASON_MAX_LENGTH = 96;

export type DeploymentFailureProjection = {
	reason: string;
	failedVerb: DeploymentOperationVerb | null;
	retryable: boolean | null;
	code: string;
};

export function deploymentFailureReason(input: {
	failure?: {
		title: string;
		conditionMessage: string;
		detail?: string;
		phase?: string | null;
	} | null;
}): string | null {
	const failure = input.failure;
	const candidates =
		failure?.phase === "plan_change"
			? [failure.detail, failure.title, failure.conditionMessage]
			: [failure?.title, failure?.conditionMessage];
	for (const candidate of candidates) {
		const reason = (candidate ?? "").trim();
		if (reason) return reason;
	}
	return null;
}

/** One tab-agnostic failure view backed by the authoritative failed snapshot. */
export function deploymentFailureProjection(
	deployment: HostedDeployment | null | undefined,
): DeploymentFailureProjection | null {
	if (deployment?.resource.status.summary_state !== "failed") return null;
	const failure = deployment.resource.status.failure;
	const reason = deploymentFailureReason(deployment.resource.status);
	if (!failure || !reason) return null;
	return {
		reason,
		failedVerb: deployment.accepted_operation?.metadata.verb ?? null,
		retryable: failure.retryable ?? null,
		code: failure.code,
	};
}

export function compactDeploymentFailureReason(
	reason: string,
	maxLength = DEFAULT_FAILURE_REASON_MAX_LENGTH,
): string {
	const compact = reason.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	if (maxLength <= 3) return compact.slice(0, maxLength);
	return `${compact.slice(0, maxLength - 3)}...`;
}
