import type { QueryClient } from "@tanstack/react-query";

export function skillDetailQueryKey(skillKey: string, selectedProjectId: string) {
	return ["skill", skillKey, selectedProjectId] as const;
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
