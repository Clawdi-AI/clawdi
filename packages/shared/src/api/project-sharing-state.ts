import type { components } from "./api.generated";

export function canManageSharing(project: components["schemas"]["ProjectResponse"]) {
	return project.is_owner && project.kind === "workspace" && !project.archived_at;
}

export function safeShareUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && value.length <= 4096
			? url.href
			: null;
	} catch {
		return null;
	}
}

export function linkIsActive(link: components["schemas"]["ShareLinkResponse"], now = Date.now()) {
	return !link.revoked_at && !linkIsExpired(link, now);
}

export function shareTokenFromUrl(value: string): string | null {
	const safe = safeShareUrl(value.trim());
	if (!safe) return null;
	// Matches the server's 32-byte URL-safe token, never an arbitrary API URL.
	return new URL(safe).pathname.match(/\/share\/([A-Za-z0-9_-]{43})\/?$/)?.[1] ?? null;
}

export function linkIsExpired(
	link: Pick<components["schemas"]["ShareLinkResponse"], "expires_at">,
	now = Date.now(),
) {
	return link.expires_at !== null && !(Date.parse(link.expires_at) > now);
}
