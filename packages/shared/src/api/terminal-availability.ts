import type { Deployment } from "./deploy";

// Post-ready runtime failures keep the running substrate so the owner can repair it.
const POST_READY_RUNTIME_FAILURE_CODES = new Set([
	"runtime_unreachable",
	"runtime_configuration_failed",
]);

/** Public readiness evidence authorizes a launch attempt, not an authenticated browser session. */
export function deploymentTerminalIsAvailable(deployment: Deployment): boolean {
	const { metadata, spec, status } = deployment.resource;
	if (spec.desired_lifecycle !== "running" || !status || status.deleted_at) return false;
	if (status.summary_state === "running") return true;
	const generation = metadata.generation;
	return Boolean(
		status.summary_state === "failed" &&
			generation >= 1 &&
			status.observedGeneration === generation &&
			status.driver_acknowledged_generation === generation &&
			status.driver_applied_generation === generation &&
			status.observed_at &&
			deployment.compute_slot_occupancy?.backing_infra === "present" &&
			status.failure &&
			POST_READY_RUNTIME_FAILURE_CODES.has(status.failure.code) &&
			status.failure.phase === "reconcile" &&
			status.failure.observedGeneration === generation,
	);
}
