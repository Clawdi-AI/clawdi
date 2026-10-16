import type { components } from "./api.generated";
import { safeShareUrl } from "./project-sharing-state";

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

export function vaultRequestsRefetchInterval(
	rows:
		| readonly Pick<components["schemas"]["VaultSecretRequestStatus"], "status">[]
		| null
		| undefined,
): number | false {
	return rows?.some((row) => row.status === "pending") ? 10_000 : false;
}
