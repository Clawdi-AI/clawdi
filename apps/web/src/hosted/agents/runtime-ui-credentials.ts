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

const LEGACY_OPENCLAW_BOOTSTRAP_STORAGE_PREFIX = "clawdi.openclaw-bootstrap-attempted";
const OPENCLAW_NATIVE_HANDOFF_LOADED_STORAGE_PREFIX = "clawdi.openclaw-native-handoff-loaded.v1";

function legacyOpenClawBootstrapStorageKey(deploymentId: string): string {
	return `${LEGACY_OPENCLAW_BOOTSTRAP_STORAGE_PREFIX}.${deploymentId}`;
}

function openClawNativeHandoffLoadedStorageKey(deploymentId: string): string {
	return `${OPENCLAW_NATIVE_HANDOFF_LOADED_STORAGE_PREFIX}.${deploymentId}`;
}

export function runtimeUiLocalStorage(
	browserWindow: { readonly localStorage: Storage } = window,
): Storage | null {
	try {
		return browserWindow.localStorage;
	} catch {
		return null;
	}
}

function removeStorageItem(storage: RuntimeUiBootstrapStorage | null, key: string): void {
	if (!storage) return;
	try {
		storage.removeItem(key);
	} catch {
		// Browser storage is only an optimization; OpenClaw remains authoritative.
	}
}

export function hasOpenClawNativeHandoffLoaded(
	storage: RuntimeUiBootstrapStorage | null,
	deploymentId: string,
	endpointUrl: string,
): boolean {
	removeStorageItem(storage, legacyOpenClawBootstrapStorageKey(deploymentId));
	if (!storage) return false;
	try {
		return storage.getItem(openClawNativeHandoffLoadedStorageKey(deploymentId)) === endpointUrl;
	} catch {
		return false;
	}
}

export function markOpenClawNativeHandoffLoaded(
	storage: RuntimeUiBootstrapStorage | null,
	deploymentId: string,
	endpointUrl: string,
	credentials: RuntimeUiCredentials | null,
): boolean {
	if (openClawHandoffMode(credentials) !== "native") return false;
	removeStorageItem(storage, legacyOpenClawBootstrapStorageKey(deploymentId));
	if (!storage) return true;
	try {
		storage.setItem(openClawNativeHandoffLoadedStorageKey(deploymentId), endpointUrl);
	} catch {
		// Browser storage is only an optimization; OpenClaw remains authoritative.
	}
	return true;
}

export function forgetOpenClawNativeHandoffLoaded(
	storage: RuntimeUiBootstrapStorage | null,
	deploymentId: string,
): void {
	removeStorageItem(storage, legacyOpenClawBootstrapStorageKey(deploymentId));
	removeStorageItem(storage, openClawNativeHandoffLoadedStorageKey(deploymentId));
}

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
	return credentials.runtime === "openclaw" ? credentials.handoff_url : credentials.url;
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
	endpointUrl: string,
	nativeHandoffLoaded: boolean,
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
	return nativeHandoffLoaded ? endpointUrl : null;
}
