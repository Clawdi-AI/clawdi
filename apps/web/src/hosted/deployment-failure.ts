import type { DeploymentOperation, HostedDeployment } from "@/hosted/billing/contracts";

const DEFAULT_FAILURE_REASON_MAX_LENGTH = 96;

export type DeploymentFailureProjection = {
	reason: string;
	failedVerb: DeploymentOperation["metadata"]["verb"] | null;
	retryable: boolean | null;
	code: string;
};

export function deploymentFailureReason(input: {
	failure?: { title: string; conditionMessage: string } | null;
}): string | null {
	for (const candidate of [input.failure?.title, input.failure?.conditionMessage]) {
		const reason = (candidate ?? "").replace(/\s+/g, " ").trim();
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
