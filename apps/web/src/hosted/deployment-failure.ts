const DEFAULT_FAILURE_REASON_MAX_LENGTH = 96;

export function deploymentFailureReason(input: { failure_reason?: string | null }): string | null {
	const reason = input.failure_reason?.replace(/\s+/g, " ").trim();
	return reason ? reason : null;
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
