import type { QueryClient } from "@tanstack/react-query";
import { isApiNotFoundError } from "@/lib/api-errors";

export type SkillDetailViewState =
	| "missing-key"
	| "not-found"
	| "error"
	| "loading"
	| "detail"
	| "empty";

/** A refetch 404 is authoritative even while TanStack retains older data. */
export function skillDetailViewState(input: {
	skillKey: string;
	error: unknown;
	hasSkill: boolean;
	isLoading: boolean;
}): SkillDetailViewState {
	if (!input.skillKey) return "missing-key";
	if (isApiNotFoundError(input.error)) return "not-found";
	if (input.error && !input.hasSkill) return "error";
	if (input.isLoading) return "loading";
	if (input.hasSkill) return "detail";
	return "empty";
}

export function skillDetailQueryKey(
	skillKey: string,
	selectedProjectId: string,
	projectionScope = "cloud",
) {
	return ["skill", skillKey, selectedProjectId, projectionScope] as const;
}

export function skillDetailQueryPrefix(skillKey: string) {
	return ["skill", skillKey] as const;
}

export async function removeDeletedSkillQueries(
	queryClient: QueryClient,
	skillKey: string,
): Promise<void> {
	queryClient.removeQueries({ queryKey: skillDetailQueryPrefix(skillKey) });
	await queryClient.invalidateQueries({ queryKey: ["skills"] });
}
