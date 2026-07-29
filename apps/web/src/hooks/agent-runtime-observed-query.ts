export const RUNTIME_OBSERVED_PENDING_REFETCH_INTERVAL_MS = 5_000;
export const RUNTIME_OBSERVED_SETTLED_REFETCH_INTERVAL_MS = 30_000;

export type RuntimeHealthSnapshot = {
	health: { status: string };
};

export function runtimeEvidenceMatchesDeployment(
	deploymentId: string,
	evidenceDeploymentId: string | null | undefined,
): boolean {
	return evidenceDeploymentId === deploymentId;
}

export function agentRuntimeObservedQueryKey(
	agentId: string,
	deploymentResourceVersion: string | undefined,
	enabled: boolean,
) {
	return [
		"runtime-observed",
		agentId,
		deploymentResourceVersion ?? "unfenced",
		enabled ? "active" : "disabled",
	] as const;
}

export function runtimeHealthIsConverged(snapshot: RuntimeHealthSnapshot): boolean {
	return snapshot.health.status === "ok";
}

export function agentRuntimeObservedRefetchInterval<TSnapshot extends RuntimeHealthSnapshot>(
	snapshot: TSnapshot | undefined,
	isConverged: (value: TSnapshot) => boolean,
): number {
	return snapshot && isConverged(snapshot)
		? RUNTIME_OBSERVED_SETTLED_REFETCH_INTERVAL_MS
		: RUNTIME_OBSERVED_PENDING_REFETCH_INTERVAL_MS;
}
