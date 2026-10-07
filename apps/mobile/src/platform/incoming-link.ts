import { publicSessionId, publicSessionInput, vaultRequestToken } from "@clawdi/shared/api";
import { isBrowserLinkPath } from "@clawdi/shared/linking";

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

/** Only verified HTTPS machine-readable files may bypass native navigation. */
export function mobileBrowserLink(path: string, hosts: readonly string[]): string | null {
	if (typeof path !== "string" || path.length > 8192 || /[\r\n\\]/.test(path)) return null;
	try {
		const url = new URL(path);
		if (
			url.protocol !== "https:" ||
			!hosts.includes(url.hostname) ||
			url.username ||
			url.password ||
			url.port ||
			!isBrowserLinkPath(decodeURIComponent(url.pathname))
		)
			return null;
		return url.href;
	} catch {
		return null;
	}
}

/** Browser injection keeps the native SDK out of link boundary tests. */
export async function routeMobileIncomingLink(
	path: string,
	hosts: readonly string[],
	stageVault: (link: string) => string,
	openBrowser: (url: string) => Promise<unknown>,
	initial: boolean,
): Promise<string | null> {
	const browserUrl = mobileBrowserLink(path, hosts);
	if (browserUrl) {
		try {
			await openBrowser(browserUrl);
			// A warm link must not replace the screen underneath the browser.
			return initial ? "/" : null;
		} catch {
			return "/open-share";
		}
	}
	return mobileLinkDestination(path, hosts, stageVault);
}

/** Explicit external-link allowlist; capability tokens never enter Router state. */
export function mobileLinkDestination(
	path: string,
	hosts: readonly string[],
	stageVault: (link: string) => string,
): string {
	if (
		typeof path !== "string" ||
		path.length > 8192 ||
		/[\r\n\\]/.test(path) ||
		path.startsWith("//")
	)
		return "/open-share";
	try {
		const url = new URL(path, "clawdi:///");
		if (url.username || url.password || url.port) return "/open-share";
		const custom = url.protocol === "clawdi:";
		if (!custom && (url.protocol !== "https:" || !hosts.includes(url.hostname)))
			return "/open-share";
		const pathname =
			(custom && url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname) || "/";
		if (isBrowserLinkPath(decodeURIComponent(pathname))) return "/open-share";
		if (pathname === "/vault-request" || pathname === "/vault-supply") {
			if (!custom && vaultRequestToken(path)) {
				const id = stageVault(path);
				if (!publicSessionId(id)) throw new Error("Invalid intake reference");
				return `/vault-request?intake=${encodeURIComponent(id)}`;
			}
			return supplyPath(url);
		}
		if (pathname.startsWith("/s/")) {
			const share = publicSessionInput(`https://local.invalid${pathname}${url.search}${url.hash}`);
			return share ? `/s/${share}` : "/open-share";
		}
		// Cheap old-mobile aliases, retaining exact object identities.
		if (pathname === "/skills/detail") {
			const key = url.searchParams.get("key") ?? url.searchParams.get("skillKey");
			if (!key) return "/skills";
			url.searchParams.delete("key");
			url.searchParams.delete("skillKey");
			const query = url.searchParams.toString();
			return `/skills/${encodeURIComponent(key)}${query ? `?${query}` : ""}`;
		}
		if (pathname === "/vault/detail") {
			const slug = url.searchParams.get("slug");
			if (!slug) return "/vault";
			url.searchParams.delete("slug");
			const query = url.searchParams.toString();
			return `/vault/${encodeURIComponent(slug)}${query ? `?${query}` : ""}`;
		}
		if (isWebPath(pathname) && url.searchParams.has("settings")) {
			const panel = url.searchParams.get("settings");
			return panel &&
				["general", "api-keys", "wallet", "compute", "billing", "account"].includes(panel)
				? `/settings/${panel}`
				: "/settings";
		}
		if (!isWebPath(pathname)) return "/open-share";
		return `${pathname}${url.search}`;
	} catch {
		return "/open-share";
	}
}

function isWebPath(path: string): boolean {
	const pieces = path.split("/").filter(Boolean).map(decodeURIComponent);
	if (pieces.some((part) => !part || part.length > 256 || /[\r\n\\]/.test(part))) return false;
	if (!pieces.length) return true;
	const [root, id, section] = pieces;
	if (
		[
			"agents",
			"sessions",
			"projects",
			"skills",
			"memories",
			"vault",
			"vaults",
			"connectors",
			"channels",
		].includes(root ?? "")
	) {
		if (root !== "agents") {
			if (pieces.length <= 2) return true;
			if (pieces.length === 3) {
				const forms: Record<string, readonly string[]> = {
					sessions: ["sharing"],
					projects: ["sharing", "edit", "agents"],
					skills: ["archive"],
					memories: ["edit"],
					vault: ["add-keys", "transfer", "split", "requests"],
					connectors: ["connect"],
					channels: ["link", "pair", "chats"],
				};
				return Boolean(section && forms[root ?? ""]?.includes(section));
			}
			return (
				(root === "projects" &&
					pieces.length === 4 &&
					section === "vaults" &&
					pieces[3] === "new") ||
				(root === "connectors" &&
					pieces.length === 5 &&
					section === "accounts" &&
					pieces[4] === "rename")
			);
		}
		if (pieces.length <= 2) return true;
		if (
			!id ||
			!section ||
			![
				"sessions",
				"memories",
				"skills",
				"vaults",
				"connectors",
				"plugins",
				"project-access",
				"console",
				"files",
				"terminal",
				"model-provider",
				"channel-links",
				"settings",
			].includes(section)
		)
			return false;
		if (section === "skills") return true;
		if (section === "project-access")
			return (
				pieces.length <= 4 ||
				(pieces.length === 5 && ["skills", "vaults"].includes(pieces[4] ?? ""))
			);
		return ["sessions", "memories", "vaults", "connectors", "plugins"].includes(section)
			? pieces.length <= 4
			: pieces.length === 3;
	}
	if (root === "ai-providers")
		return (
			pieces.length === 1 ||
			(pieces.length === 2 && id === "new") ||
			(pieces.length === 3 && ["edit", "remove", "oauth"].includes(section ?? ""))
		);
	if (root === "terminal") return pieces.length === 2;
	if (root === "share") return pieces.length === 2 && /^[A-Za-z0-9_-]{43}$/.test(id ?? "");
	if (root === "settings") return pieces.length <= 4;
	return (
		pieces.length === 1 &&
		["ai-providers", "deploy", "sign-in", "sign-up", "library", "open-share"].includes(root ?? "")
	);
}

function supplyPath(url: URL): string {
	const id =
		url.searchParams.getAll("intake").length === 1
			? publicSessionId(url.searchParams.get("intake") ?? "")
			: null;
	return id ? `/vault-request?intake=${id}` : "/vault-request";
}
