const DEFAULT_FAILURE_REASON_MAX_LENGTH = 96;

export function deploymentFailureReason(input: {
	failure?: { title: string; conditionMessage: string } | null;
}): string | null {
	for (const candidate of [input.failure?.title, input.failure?.conditionMessage]) {
		const reason = (candidate ?? "").replace(/\s+/g, " ").trim();
		if (reason) return reason;
	}
	return null;
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
