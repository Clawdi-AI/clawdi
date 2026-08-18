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

type RuntimeUiBootstrapStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

const OPENCLAW_BOOTSTRAP_STORAGE_PREFIX = "clawdi.openclaw-bootstrap-attempted";

function openClawBootstrapStorageKey(deploymentId: string): string {
	return `${OPENCLAW_BOOTSTRAP_STORAGE_PREFIX}.${deploymentId}`;
}

export function hasOpenClawBootstrapAttempt(
	storage: RuntimeUiBootstrapStorage,
	deploymentId: string,
	endpointUrl: string,
): boolean {
	try {
		return storage.getItem(openClawBootstrapStorageKey(deploymentId)) === endpointUrl;
	} catch {
		return false;
	}
}

export function rememberOpenClawBootstrapAttempt(
	storage: RuntimeUiBootstrapStorage,
	deploymentId: string,
	endpointUrl: string,
): void {
	try {
		storage.setItem(openClawBootstrapStorageKey(deploymentId), endpointUrl);
	} catch {
		// Browser storage is only an optimization; OpenClaw remains authoritative.
	}
}

export function forgetOpenClawBootstrapAttempt(
	storage: RuntimeUiBootstrapStorage,
	deploymentId: string,
): void {
	try {
		storage.removeItem(openClawBootstrapStorageKey(deploymentId));
	} catch {
		// A fresh handoff can still proceed when browser storage is unavailable.
	}
}

export function openSecureRuntimeWindow(
	openWindow: OpenRuntimeWindow,
	url = "about:blank",
): RuntimeWindow | null {
	const popup = openWindow("about:blank", "_blank");
	if (!popup) return null;
	popup.opener = null;
	try {
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
	return credentials.runtime === "openclaw" ? credentials.handoff_url : credentials.url;
}

export async function loadRuntimeUiWindowTarget(
	runtime: RuntimeUiCredentials["runtime"],
	endpointUrl: string,
	requestCredentials: () => Promise<RuntimeUiCredentials>,
): Promise<string> {
	if (runtime === "hermes") return endpointUrl;
	return runtimeUiLaunchTarget(await requestCredentials());
}
