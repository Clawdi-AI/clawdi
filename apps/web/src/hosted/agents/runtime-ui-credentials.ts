import { isRuntimeUiCredentials, type RuntimeUiCredentials } from "@clawdi/shared/api";

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

export function openSecureRuntimeWindow(openWindow: OpenRuntimeWindow): RuntimeWindow | null {
	// `noopener` may intentionally make window.open return null even when the
	// browser opened the tab, which would leave an async token handoff unable
	// to navigate it. Detach the synchronously opened placeholder immediately.
	const popup = openWindow("about:blank", "_blank");
	if (popup) popup.opener = null;
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
	return credentials.runtime === "openclaw" ? credentials.handoff_url : credentials.url;
}
