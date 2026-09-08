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
				throw new Error(
					"A Skill detail response did not match the requested Workspace or Project.",
				);
			}
			return skill;
		} catch (error) {
			if (!isNotFoundError(error)) throw error;
			lastNotFoundError = error;
		}
	}

	if (lastNotFoundError !== undefined) throw lastNotFoundError;
	throw new Error("This Agent has no available Workspace or Project for this Skill.");
}
