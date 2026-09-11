import { isRuntimeUiCredentials, type RuntimeUiCredentials } from "@clawdi/shared/api";
import { runtimeDashboardUrl } from "@/hosted/runtimes";

type RuntimeWindow = {
	close(): void;
	location: { replace(url: string | URL): void };
	opener: unknown;
};
type OpenRuntimeWindow = (
	url?: string | URL,
	target?: string,
	features?: string,
) => RuntimeWindow | null;

export function openSecureRuntimeWindow(
	openWindow: OpenRuntimeWindow,
	url = "about:blank",
): RuntimeWindow | null {
	const popup = openWindow("about:blank", "_blank");
	if (!popup) return null;
	try {
		popup.opener = null;
		if (url !== "about:blank") popup.location.replace(url);
	} catch {
		try {
			popup.close();
		} catch {
			// Browser isolation may have severed the WindowProxy.
		}
		return null;
	}
	return popup;
}

function targetsCleanPublishedEndpoint(credentialUrl: string, endpointUrl: string): boolean {
	try {
		const credentialTarget = new URL(credentialUrl);
		const publishedTarget = new URL(endpointUrl);
		return (
			credentialTarget.protocol === "https:" &&
			credentialTarget.search === "" &&
			credentialTarget.hash === "" &&
			publishedTarget.search === "" &&
			publishedTarget.hash === "" &&
			credentialTarget.href === publishedTarget.href
		);
	} catch {
		return false;
	}
}

function hasCurrentDeploymentResourceVersion(
	credentials: RuntimeUiCredentials,
	deploymentResourceVersion: string,
): boolean {
	return credentials.deployment_resource_version === deploymentResourceVersion;
}

export function resolveRuntimeUiCredentials(
	credentials: RuntimeUiCredentials,
	endpointUrl: string,
	deploymentResourceVersion: string,
): RuntimeUiCredentials | null {
	if (
		!isRuntimeUiCredentials(credentials) ||
		!hasCurrentDeploymentResourceVersion(credentials, deploymentResourceVersion) ||
		!targetsCleanPublishedEndpoint(credentials.url, endpointUrl)
	) {
		return null;
	}
	return credentials;
}

export function runtimeUiLaunchTarget(credentials: RuntimeUiCredentials): string {
	return credentials.runtime === "openclaw"
		? credentials.handoff_url
		: runtimeDashboardUrl(credentials.url, credentials.runtime);
}

export function openClawHandoffMode(
	credentials: RuntimeUiCredentials | null,
): "legacy" | "native" | null {
	if (credentials?.runtime !== "openclaw") return null;
	try {
		const fragment = new URL(credentials.handoff_url).hash.slice(1);
		const params = new URLSearchParams(fragment);
		if (params.has("bootstrapToken")) return "native";
		if (params.has("token")) return "legacy";
	} catch {
		// The credential response validator remains authoritative for malformed handoffs.
	}
	return null;
}

export function openClawRuntimeUiWindowTarget(
	credentials: RuntimeUiCredentials | null,
	frameLoaded: boolean,
): string | null {
	if (!frameLoaded) return null;
	const handoffMode = openClawHandoffMode(credentials);
	if (handoffMode === "legacy" && credentials?.runtime === "openclaw") {
		return credentials.handoff_url;
	}
	if (handoffMode === "native" && credentials?.runtime === "openclaw") {
		return credentials.url;
	}
	return null;
}
