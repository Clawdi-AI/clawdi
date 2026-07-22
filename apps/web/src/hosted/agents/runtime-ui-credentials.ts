import type { RuntimeUiCredentials } from "@clawdi/shared/api";

export interface HermesUiCredentials {
	url: string;
	username: string;
	password: string;
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
