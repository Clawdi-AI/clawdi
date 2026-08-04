export type AgentSkillProjectAccess =
	| { kind: "bound"; projectIds: string[] }
	| { kind: "unavailable" }
	| { kind: "unbound"; projectId: string };

/**
 * Resolve a detail URL against the Agent's bindings. Explicit Project context
 * stays strict. Legacy URLs without context may use only the unique primary
 * Workspace and never search or aggregate context Projects.
 */
export function resolveAgentSkillProjectAccess(
	bindings: readonly { project_id: string; binding_type: string }[],
	requestedProjectId: string,
): AgentSkillProjectAccess {
	if (!requestedProjectId) {
		const primaryBindings = bindings.filter((binding) => binding.binding_type === "primary");
		return primaryBindings.length === 1 && primaryBindings[0]
			? { kind: "bound", projectIds: [primaryBindings[0].project_id] }
			: { kind: "unavailable" };
	}
	if (!bindings.some((binding) => binding.project_id === requestedProjectId)) {
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
