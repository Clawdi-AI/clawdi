import type { components } from "./api.generated";
import { safeShareUrl } from "./project-sharing-state";
import type { VaultIdentity } from "./vault-client";
import { REQUEST_FIELD_NAME_RE } from "./vault-key-import";

/** Names only; values and request capabilities never belong in query keys. */
export function buildVaultSecretRequest(
	vault: VaultIdentity,
	projectId: string,
	section: string,
	names: string,
	expiresInSeconds: number,
): components["schemas"]["VaultSecretRequestCreate"] {
	const fields = names
		.split(/[,\r\n]/)
		.map((name) => name.trim())
		.filter(Boolean);
	const normalizedSection = section.trim();
	if (
		!vault.id ||
		!vault.slug ||
		!projectId ||
		fields.length < 1 ||
		fields.length > 32 ||
		fields.some((field) => !REQUEST_FIELD_NAME_RE.test(field)) ||
		new Set(fields).size !== fields.length ||
		(normalizedSection !== "" && !REQUEST_FIELD_NAME_RE.test(normalizedSection)) ||
		!Number.isInteger(expiresInSeconds) ||
		expiresInSeconds < 300 ||
		expiresInSeconds > 86400
	) {
		throw new Error("Invalid secret request");
	}
	return {
		vault_id: vault.id,
		slug: vault.slug,
		project_id: projectId,
		section: normalizedSection,
		fields,
		expires_in_seconds: expiresInSeconds,
	};
}

/** Capability lives in the fragment, not an API request URL or navigation state. */
export function safeVaultRequestUrl(value: string): string | null {
	const safe = safeShareUrl(value);
	if (!safe) return null;
	const url = new URL(safe);
	return url.pathname === "/vault-request" &&
		!url.search &&
		/^#v2_[A-Za-z0-9_-]{43}$/.test(url.hash)
		? url.href
		: null;
}
