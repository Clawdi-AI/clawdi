export type AgentSkillProjectAccess =
	| { kind: "bound"; projectIds: string[] }
	| { kind: "missing" }
	| { kind: "unbound"; projectId: string };

/**
 * Resolve a detail URL against the Agent's effective Project access.
 * Detail reads require one explicit Project and never aggregate candidates.
 */
export function resolveAgentSkillProjectAccess(
	effectiveProjectIds: readonly string[],
	requestedProjectId: string,
): AgentSkillProjectAccess {
	const projectIds = Array.from(new Set(effectiveProjectIds));
	if (!requestedProjectId) return { kind: "missing" };
	if (!projectIds.includes(requestedProjectId)) {
		return { kind: "unbound", projectId: requestedProjectId };
	}
	return { kind: "bound", projectIds: [requestedProjectId] };
}

/**
 * Read one Skill through Project-explicit endpoints. A 404 advances to the
 * next effective Project; every other failure stops resolution so access does
 * not silently fall through after an indeterminate response.
 */
export async function fetchAgentScopedSkillDetail<T extends { project_id?: string | null }>(
	projectIds: readonly string[],
	fetchSkill: (projectId: string) => Promise<T>,
	isNotFoundError: (error: unknown) => boolean,
): Promise<T> {
	let lastNotFoundError: unknown;

	for (const projectId of projectIds) {
		try {
			const skill = await fetchSkill(projectId);
			if (skill.project_id !== projectId) {
				throw new Error("A Skill detail response did not match the requested Agent Project.");
			}
			return skill;
		} catch (error) {
			if (!isNotFoundError(error)) throw error;
			lastNotFoundError = error;
		}
	}

	if (lastNotFoundError !== undefined) throw lastNotFoundError;
	throw new Error("This Agent has no available Projects for this Skill.");
}
