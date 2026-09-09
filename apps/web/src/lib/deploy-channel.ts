const CAPTURE_KEY = "clawdi-deploy-channel";

export function resolveDeployChannel(search: string): "sui" | null {
	const params = new URLSearchParams(search);
	const direct = params.get("deploy_profile") ?? params.get("utm_source");
	if (direct !== null) return direct === "sui" ? "sui" : null;
	const redirect = params.get("redirect_url");
	if (!redirect?.startsWith("/") || redirect.startsWith("//") || redirect.includes("\\"))
		return null;
	try {
		const nested = new URL(redirect, "https://clawdi.invalid").searchParams;
		return (nested.get("deploy_profile") ?? nested.get("utm_source")) === "sui" ? "sui" : null;
	} catch {
		return null;
	}
}

export function captureDeployChannel(): void {
	if (resolveDeployChannel(window.location.search) !== "sui") return;
	try {
		window.localStorage.setItem(CAPTURE_KEY, "sui");
	} catch {
		/* URL remains available if browser storage is disabled. */
	}
}

export function claimDeployChannel(userId: string): boolean {
	const key = `${CAPTURE_KEY}:${userId}`;
	try {
		if (window.localStorage.getItem(CAPTURE_KEY) === "sui") {
			window.localStorage.setItem(key, "sui");
			window.localStorage.removeItem(CAPTURE_KEY);
		}
		return window.localStorage.getItem(key) === "sui";
	} catch {
		return resolveDeployChannel(window.location.search) === "sui";
	}
}

export function completeDeployChannelClaim(userId: string): void {
	try {
		window.localStorage.removeItem(`${CAPTURE_KEY}:${userId}`);
	} catch {
		/* Server persistence already succeeded. */
	}
}
