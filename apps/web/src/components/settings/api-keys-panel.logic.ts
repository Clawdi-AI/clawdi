import type { ApiKey } from "@/lib/api-schemas";

export const API_KEYS_QUERY_KEY = ["get", "/v1/auth/keys"] as const;

/** Keep revoked keys out of the UI while older backends are still in a rolling deployment. */
export function activeApiKeys(keys: readonly ApiKey[] | undefined): ApiKey[] {
	return keys?.filter((key) => key.revoked_at === null) ?? [];
}

export function removeApiKeyFromList(
	keys: readonly ApiKey[] | undefined,
	keyId: string,
): ApiKey[] | undefined {
	return keys?.filter((key) => key.id !== keyId);
}

/** Restore only the failed optimistic removal so concurrent successful revokes stay removed. */
export function restoreApiKeyToList(keys: readonly ApiKey[] | undefined, key: ApiKey): ApiKey[] {
	if (keys?.some((candidate) => candidate.id === key.id)) return [...keys];
	return [...(keys ?? []), key].sort(
		(left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
	);
}
