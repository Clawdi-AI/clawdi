import {
	type FilesHandoff,
	isRuntimeUiCredentials,
	type RuntimeUiCredentials,
	type RuntimeUiEndpointInfo,
} from "./deploy";
import { ApiClientError, ApiClientNetworkError } from "./read-transport";

type HostedRuntime = RuntimeUiEndpointInfo["runtime"];

/** Browser entry only; credential validation still uses the exact published endpoint. */
export function runtimeDashboardUrl(url: string, runtime: HostedRuntime): string {
	if (runtime !== "hermes") return url;
	try {
		const target = new URL(url);
		const path = target.pathname.replace(/\/+$/, "");
		// Hosted path-based proxy roots end in the Hermes dashboard port.
		if (path !== "" && !path.endsWith("-9119")) return url;
		target.pathname = `${path}/chat`;
		return target.toString();
	} catch {
		return url;
	}
}

/** Start Hermes OIDC at its own login route so Hermes creates the PKCE/state cookies. */
export function hermesOidcLoginUrl(url: string): string {
	try {
		const dashboard = new URL(runtimeDashboardUrl(url, "hermes"));
		const dashboardPath = dashboard.pathname.replace(/\/+$/, "");
		if (!dashboardPath.endsWith("/chat")) return url;
		dashboard.pathname = `${dashboardPath.slice(0, -"/chat".length)}/auth/login`;
		dashboard.search = new URLSearchParams({
			provider: "self-hosted",
			next: `${dashboardPath}`,
		}).toString();
		dashboard.hash = "";
		return dashboard.toString();
	} catch {
		return url;
	}
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

/** Hosted's reserved one-time redeem route; Files ForwardAuth consumes it before FileBrowser. */
const FILES_HANDOFF_PATH = "/__clawdi/files/handoff";

/** Accepts only a single-code redeem URL on the reviewed Files origin for the current version. */
export function resolveFilesHandoff(
	handoff: unknown,
	filesUrl: string,
	deploymentResourceVersion: string,
): FilesHandoff | null {
	if (
		typeof handoff !== "object" ||
		handoff === null ||
		!("url" in handoff) ||
		!("expires_at" in handoff) ||
		!("deployment_resource_version" in handoff)
	)
		return null;
	const { url, expires_at, deployment_resource_version } = handoff;
	if (
		typeof url !== "string" ||
		typeof expires_at !== "string" ||
		deployment_resource_version !== deploymentResourceVersion ||
		url.includes("#")
	)
		return null;
	try {
		const target = new URL(url);
		const files = new URL(filesUrl);
		if (
			files.protocol !== "https:" ||
			target.protocol !== "https:" ||
			target.origin !== files.origin ||
			target.username ||
			target.password ||
			target.pathname !== FILES_HANDOFF_PATH ||
			[...target.searchParams.keys()].join() !== "code" ||
			!target.searchParams.get("code")
		)
			return null;
	} catch {
		return null;
	}
	return { url, expires_at, deployment_resource_version };
}

/** The reviewed Files endpoint no longer matches the deployment read just before minting. */
export class FilesEndpointChangedError extends Error {
	constructor() {
		super("Files endpoint changed");
		this.name = "FilesEndpointChangedError";
	}
}

export type FilesHandoffFailure =
	| "changed"
	| "unavailable"
	| "signed_out"
	| "rate_limited"
	| "offline"
	| "failed";

export function filesHandoffFailure(error: unknown): FilesHandoffFailure {
	if (error instanceof FilesEndpointChangedError) return "changed";
	if (error instanceof ApiClientNetworkError) return "offline";
	if (!(error instanceof ApiClientError)) return "failed";
	// Hosted: 412 stale If-Match, 409 Files not ready or stopped, 401 inactive Clerk session.
	if (error.status === 412) return "changed";
	if (error.status === 409) return "unavailable";
	if (error.status === 401) return "signed_out";
	if (error.status === 429) return "rate_limited";
	return "failed";
}
