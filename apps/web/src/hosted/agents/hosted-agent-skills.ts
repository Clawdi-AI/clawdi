import type { components } from "@clawdi/shared/api";
import { runtimeEvidenceMatchesDeployment } from "@/hooks/agent-runtime-observed-query";
import type {
	DeploymentUpdateRequest,
	HostedDeployment,
	HostedDeploymentSpec,
} from "@/hosted/billing/contracts";

export type ManifestSkillConfiguration = HostedDeploymentSpec["skills"][number];
type RuntimeObserved = components["schemas"]["AgentRuntimeObservedResponse"];

export type ManifestSkillConvergence = "converged" | "pending" | "unavailable";

function isSupportedManifestSkills(skills: readonly ManifestSkillConfiguration[]): boolean {
	return (
		skills.length === 1 &&
		skills[0]?.id === "clawdi" &&
		typeof skills[0].enabled === "boolean" &&
		skills[0].version === 1
	);
}

/** Hosted GET/list/LRO projections are the only manifest desired-state source. */
export function canonicalManifestSkills(
	deployment: HostedDeployment,
): [ManifestSkillConfiguration] {
	const skills = deployment.resource.spec.skills;
	if (!Array.isArray(skills)) {
		throw new Error("Unsupported manifest Skill configuration");
	}
	const skill = skills[0];
	if (!skill || !isSupportedManifestSkills(skills)) {
		throw new Error("Unsupported manifest Skill configuration");
	}
	return [{ id: skill.id, enabled: skill.enabled, version: skill.version }];
}

/** Build the public PATCH full-replacement field, or null for a same-value no-op. */
export function buildManifestSkillUpdate(
	current: readonly ManifestSkillConfiguration[],
	nextEnabled: boolean,
): DeploymentUpdateRequest | null {
	const skill = current[0];
	if (!skill || !isSupportedManifestSkills(current)) {
		throw new Error("Unsupported manifest Skill configuration");
	}
	if (skill.enabled === nextEnabled) return null;
	return {
		skills: current.map((skill) => ({
			id: skill.id,
			enabled: skill.id === "clawdi" ? nextEnabled : skill.enabled,
			version: skill.version,
		})),
	};
}

/**
 * Runtime state is downstream evidence only. The backend health field already
 * applies instance, deployment, source, freshness, and generation fences; Web
 * must not replace it with a generation-only algorithm.
 */
export function manifestSkillConvergence(
	canonical: ManifestSkillConfiguration,
	runtime: RuntimeObserved | null | undefined,
	deploymentId: string,
): ManifestSkillConvergence {
	if (!runtime) return "unavailable";
	const observedDesired = runtime.desired?.managed_skills?.find(
		(skill) => skill.id === canonical.id,
	);
	if (
		runtimeEvidenceMatchesDeployment(deploymentId, runtime.desired?.deployment_id) &&
		runtime.health.status === "ok" &&
		observedDesired?.enabled === canonical.enabled &&
		observedDesired.version === canonical.version
	) {
		return "converged";
	}
	return "pending";
}
