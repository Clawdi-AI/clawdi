import type { RuntimeObservedSummary } from "@/hosted/v2/ai-providers/types";

export type ProviderObservedHealth = {
	status: "ok" | "degraded" | "unobserved";
	agentCount: number;
	reason: string | null;
};

type RuntimeObservedItem = RuntimeObservedSummary["items"][number];
type ProviderRuntimeObservedSummary = {
	items: Array<Pick<RuntimeObservedItem, "health" | "provider_health">>;
};

const REASON_MESSAGE: Readonly<Record<string, string>> = {
	provider_error: "The runtime reported a provider error.",
	provider_not_configured: "The provider is not configured in the runtime.",
	provider_secret_missing: "The runtime cannot access this provider credential.",
	secret_missing: "The runtime cannot access this provider credential.",
	runtime_error: "The agent runtime reported an error.",
	supervisor_error: "The agent runtime supervisor reported an error.",
	daemon_error: "The agent daemon reported an error.",
};
const STALE_REASONS = new Set(["daemon_stale", "runtime_observed_stale"]);

export function providerObservedHealth(
	providerId: string,
	summary: ProviderRuntimeObservedSummary | null | undefined,
): ProviderObservedHealth {
	if (!summary) return { status: "unobserved", agentCount: 0, reason: null };

	const assignments = summary.items.flatMap((item) => {
		const provider = item.provider_health.find(
			(candidate) => candidate.provider_id === providerId && candidate.desired?.selected === true,
		);
		return provider ? [{ health: item.health, provider }] : [];
	});
	if (assignments.length === 0) {
		return { status: "unobserved", agentCount: 0, reason: null };
	}

	const freshAssignments = assignments.filter(
		({ health }) => !health.reasons.some((reason) => STALE_REASONS.has(reason)),
	);
	const explicitFailure = freshAssignments.find(
		({ provider }) => provider.status === "error" || provider.status === "not_configured",
	);
	if (explicitFailure) {
		const reasonCode = [
			...explicitFailure.provider.reasons,
			...explicitFailure.health.reasons,
		].find((reason) => REASON_MESSAGE[reason] !== undefined);
		const fallbackReason =
			explicitFailure.provider.status === "not_configured"
				? REASON_MESSAGE.provider_not_configured
				: "The agent runtime reported a provider issue.";
		return {
			status: "degraded",
			agentCount: assignments.length,
			reason: reasonCode ? REASON_MESSAGE[reasonCode] : fallbackReason,
		};
	}

	if (
		freshAssignments.length === assignments.length &&
		freshAssignments.every(
			({ health, provider }) => health.status === "ok" && provider.status === "ok",
		)
	) {
		return { status: "ok", agentCount: assignments.length, reason: null };
	}

	return { status: "unobserved", agentCount: assignments.length, reason: null };
}
