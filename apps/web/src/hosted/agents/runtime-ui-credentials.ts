import type { RuntimeUiCredentials } from "@clawdi/shared/api";

export interface HermesUiCredentials {
	url: string;
	username: string;
	password: string;
}

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

export function hermesCredentialsForGeneration(
	credentials: HermesUiCredentials | null,
	credentialGeneration: number | null,
	deploymentGeneration: number,
): HermesUiCredentials | null {
	return credentialGeneration === deploymentGeneration ? credentials : null;
}

function targetsPublishedEndpoint(credentialUrl: string, endpointUrl: string): boolean {
	try {
		const credentialTarget = new URL(credentialUrl);
		credentialTarget.hash = "";
		return credentialTarget.href === new URL(endpointUrl).href;
	} catch {
		return false;
	}
}

export function hermesUiCredentials(
	credentials: RuntimeUiCredentials,
	endpointUrl: string,
): HermesUiCredentials | null {
	if (
		credentials.runtime !== "hermes" ||
		credentials.auth_mode !== "password" ||
		!credentials.username ||
		!credentials.password ||
		!targetsPublishedEndpoint(credentials.url, endpointUrl)
	) {
		return null;
	}
	return {
		url: credentials.url,
		username: credentials.username,
		password: credentials.password,
	};
}

export function openClawUiUrl(
	credentials: RuntimeUiCredentials,
	endpointUrl: string,
): string | null {
	if (
		credentials.runtime !== "openclaw" ||
		credentials.auth_mode !== "openclaw_device" ||
		!targetsPublishedEndpoint(credentials.url, endpointUrl)
	) {
		return null;
	}
	return credentials.url;
}
