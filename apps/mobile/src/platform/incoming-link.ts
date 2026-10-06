import { publicSessionId, publicSessionInput, vaultRequestToken } from "@clawdi/shared/api";
import { accountOAuthNavigation } from "@/platform/auth/account-oauth";

/** One pending capability, never Router state, storage, logs or query keys. */
export function createVaultLinkInbox(now = Date.now) {
	let pending: { id: string; link: string; expiresAt: number } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const clear = (id?: string) => {
		if (id && pending?.id !== id) return;
		pending = undefined;
		clearTimeout(timer);
		timer = undefined;
	};
	return {
		clear,
		stage: (id: string, link: string) => {
			if (!publicSessionId(id) || !vaultRequestToken(link)) throw new Error("Invalid link intake");
			clear();
			pending = { id, link, expiresAt: now() + 60_000 };
			timer = setTimeout(() => clear(id), 60_000);
			return id;
		},
		take: (id: string) => {
			if (pending?.id !== id) return null;
			const link = now() < pending.expiresAt ? pending.link : null;
			clear(id);
			return link;
		},
	};
}

export const incomingVaultLink = createVaultLinkInbox();

/** Explicit external-link allowlist; callback credentials never enter Router state. */
export function mobileLinkDestination(
	path: string,
	hosts: readonly string[],
	stageVault: (link: string) => string,
): string {
	if (typeof path !== "string" || path.length > 8192) return "/open-share";
	const oauth = accountOAuthNavigation(path);
	if (oauth !== path) return oauth;
	try {
		if (/^\/?vault-request(?:[?#/]|$)/i.test(path)) return "/vault-supply";
		const absolute = /^[a-z][a-z0-9+.-]*:/i.test(path);
		if (!absolute) {
			if (path.startsWith("//") || /[\r\n\\]/.test(path)) return "/open-share";
			if (/^\/?vault-supply(?:[?#/]|$)/i.test(path)) return supplyPath(new URL(path, "clawdi:///"));
			if (/^\/?s\//.test(path)) {
				const share = publicSessionInput(`https://local.invalid/${path.replace(/^\//, "")}`);
				return share ? `/s/${share}` : "/open-share";
			}
			return path;
		}
		const url = new URL(path);
		if (url.username || url.password || url.port) return "/open-share";
		if (url.protocol === "clawdi:") {
			if (url.hostname === "vault-request" || url.pathname === "/vault-request")
				return "/vault-supply";
			if (url.hostname === "vault-supply" || url.pathname === "/vault-supply")
				return supplyPath(url);
			const share = publicSessionInput(path);
			return share
				? `/s/${share}`
				: url.hostname === "s" || url.pathname.startsWith("/s/")
					? "/open-share"
					: path;
		}
		if (url.protocol !== "https:" || !hosts.includes(url.hostname)) return "/open-share";
		if (url.pathname === "/vault-request") {
			if (!vaultRequestToken(path)) return "/vault-supply";
			const id = stageVault(path);
			if (!publicSessionId(id)) throw new Error("Invalid intake reference");
			return `/vault-supply?intake=${encodeURIComponent(id)}`;
		}
		const share = publicSessionInput(path);
		return share ? `/s/${share}` : "/open-share";
	} catch {
		return "/open-share";
	}
}

function supplyPath(url: URL): string {
	const id =
		url.searchParams.getAll("intake").length === 1
			? publicSessionId(url.searchParams.get("intake") ?? "")
			: null;
	return id ? `/vault-supply?intake=${id}` : "/vault-supply";
}
