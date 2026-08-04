/** Legacy flat collections only resolve an explicit bound Project, never a default. */
export function resolveAgentProjectResourceContext(
	bindings: readonly { project_id: string }[],
	requestedProjectId: string | null | undefined,
): string | null {
	const projectId = requestedProjectId?.trim();
	if (!projectId) return null;
	return bindings.some((binding) => binding.project_id === projectId) ? projectId : null;
}
