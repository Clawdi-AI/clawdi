/**
 * Legacy flat Agent resources resolve an explicit binding strictly. When the
 * old URL omitted Project context, only the Agent's unique primary Workspace
 * is a valid compatibility target; context Projects are never guessed.
 */
export function resolveAgentProjectResourceContext(
	bindings: readonly { project_id: string; binding_type: string }[],
	requestedProjectId: string | null | undefined,
): string | null {
	const projectId = requestedProjectId?.trim();
	if (projectId) {
		return bindings.some((binding) => binding.project_id === projectId) ? projectId : null;
	}

	const primaryBindings = bindings.filter((binding) => binding.binding_type === "primary");
	return primaryBindings.length === 1 ? (primaryBindings[0]?.project_id ?? null) : null;
}
