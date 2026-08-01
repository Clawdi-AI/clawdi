import type { components } from "@/lib/api-schemas";

export type AgentProjectBinding = components["schemas"]["AgentProjectBindingResponse"];

/** Primary first, followed by context Projects in the agent's effective read order. */
export function orderedAgentProjectBindings(
	bindings: readonly AgentProjectBinding[],
): AgentProjectBinding[] {
	return [
		...bindings.filter((binding) => binding.binding_type === "primary"),
		...bindings
			.filter((binding) => binding.binding_type === "context")
			.sort(
				(left, right) =>
					left.priority - right.priority ||
					left.created_at.localeCompare(right.created_at) ||
					left.id.localeCompare(right.id),
			),
	];
}

export function effectiveAgentProjectIds(bindings: readonly AgentProjectBinding[]): string[] {
	return Array.from(
		new Set(orderedAgentProjectBindings(bindings).map((binding) => binding.project_id)),
	);
}

/**
 * Bindings are the effective-access authority. AgentResponse.default_project_id
 * is only a consistency fence: when present it must match the single primary
 * binding and never expands scope when bindings are missing or stale.
 */
export function resolveAgentProjectScope(
	bindings: readonly AgentProjectBinding[],
	expectedPrimaryProjectId?: string | null,
): { bindings: AgentProjectBinding[]; projectIds: string[] } {
	const primaryBindings = bindings.filter((binding) => binding.binding_type === "primary");
	if (primaryBindings.length !== 1) {
		throw new Error("The Agent Project is not available yet. Refresh and try again.");
	}
	const primary = primaryBindings[0];
	if (!primary) {
		throw new Error("The Agent Project is not available yet. Refresh and try again.");
	}
	if (expectedPrimaryProjectId && primary.project_id !== expectedPrimaryProjectId) {
		throw new Error("The Agent Project is still syncing. Refresh and try again.");
	}

	const orderedBindings = orderedAgentProjectBindings(bindings);
	return {
		bindings: orderedBindings,
		projectIds: Array.from(new Set(orderedBindings.map((binding) => binding.project_id))),
	};
}
