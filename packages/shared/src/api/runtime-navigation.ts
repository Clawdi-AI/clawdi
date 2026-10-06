import {
	isRuntimeUiCredentials,
	type RuntimeUiCredentials,
	type RuntimeUiEndpointInfo,
} from "./deploy";

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
