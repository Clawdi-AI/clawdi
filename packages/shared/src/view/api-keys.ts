import type { components } from "../api/api.generated";

type ApiKey = components["schemas"]["ApiKeyResponse"];

export const API_KEYS_QUERY_KEY = ["get", "/v1/auth/keys"] as const;

/** Permission labels for personal-key scopes, grouped by resource. */
const API_KEY_SCOPE_GROUPS: ReadonlyArray<{
	label: string;
	scopes: ReadonlyArray<{ scope: string; label: string }>;
}> = [
	{
		label: "Sessions",
		scopes: [
			{ scope: "sessions:read", label: "read" },
			{ scope: "sessions:write", label: "write" },
		],
	},
	{
		label: "Skills",
		scopes: [
			{ scope: "skills:read", label: "read" },
			{ scope: "skills:write", label: "write" },
		],
	},
	{
		label: "Memories",
		scopes: [
			{ scope: "memories:read", label: "read" },
			{ scope: "memories:write", label: "write" },
		],
	},
	{ label: "Projects", scopes: [{ scope: "projects:read", label: "read" }] },
	{
		label: "Vault",
		scopes: [
			{ scope: "vault:read", label: "read" },
			{ scope: "vault:write", label: "write" },
		],
	},
	{
		label: "Connectors",
		scopes: [
			{ scope: "connectors:read", label: "read" },
			{ scope: "connectors:invoke", label: "invoke" },
		],
	},
];

/** Human-readable permission summary; `null` scopes are legacy full-access keys. */
export function describeApiKeyScopes(scopes: readonly string[] | null): string {
	if (scopes === null) return "Full access (legacy)";
	const remaining = new Set(scopes);
	const parts: string[] = [];
	for (const group of API_KEY_SCOPE_GROUPS) {
		const granted = group.scopes.filter((option) => remaining.delete(option.scope));
		if (granted.length === 0) continue;
		parts.push(`${group.label} (${granted.map((option) => option.label).join(", ")})`);
	}
	parts.push(...remaining);
	return parts.length > 0 ? parts.join(", ") : "No permissions";
}

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
