import { upsertAuthoritativeDeployment } from "@clawdi/shared/view";
import type { QueryClient } from "@tanstack/react-query";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { BillingApiError } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/query-keys";

export function hermesOidcAuthorityIdentity(
	principalIdentity: string | null,
	deploymentId: string,
	endpointUrl: string,
	browserSessionUrl: string,
	accessRevision: number,
): string {
	return JSON.stringify([
		principalIdentity,
		deploymentId,
		endpointUrl,
		browserSessionUrl,
		accessRevision,
	]);
}

export const HERMES_OIDC_BROWSER_SESSION_REFRESH_MS = 45 * 60 * 1000;

function strongResourceEtag(resourceVersion: string): string {
	const valid =
		resourceVersion.length > 0 &&
		resourceVersion.length <= 128 &&
		Array.from(resourceVersion).every((character) => {
			const code = character.charCodeAt(0);
			return code >= 0x21 && code <= 0x7e && character !== '"' && character !== "\\";
		});
	if (!valid) throw new Error("Invalid deployment resource version.");
	return `"${resourceVersion}"`;
}

export async function primeHermesOidcBrowserSession(
	url: string,
	deploymentId: string,
	trustedApiOrigin: string,
	token: string,
	resourceVersion: string,
	signal: AbortSignal,
): Promise<void> {
	const target = new URL(url);
	if (
		target.protocol !== "https:" ||
		target.origin !== trustedApiOrigin ||
		target.username ||
		target.password ||
		target.search ||
		target.hash ||
		target.pathname !== `/v2/deployments/${encodeURIComponent(deploymentId)}/hermes-oidc/session`
	) {
		throw new Error("Invalid Hermes browser session endpoint.");
	}
	const response = await fetch(target, {
		method: "POST",
		credentials: "include",
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
		headers: {
			Authorization: `Bearer ${token}`,
			"If-Match": strongResourceEtag(resourceVersion),
		},
	});
	if (response.status !== 204) {
		throw new BillingApiError(response.status, "Hermes browser session could not be established.");
	}
}

export async function primeHermesOidcBrowserSessionWithRefetch({
	url,
	deploymentId,
	trustedApiOrigin,
	token,
	resourceVersion,
	signal,
	getDeployment,
	queryClient,
}: {
	url: string;
	deploymentId: string;
	trustedApiOrigin: string;
	token: string;
	resourceVersion: string;
	signal: AbortSignal;
	getDeployment: (id: string) => Promise<HostedDeployment>;
	queryClient: QueryClient;
}): Promise<string> {
	const prime = (version: string) =>
		primeHermesOidcBrowserSession(url, deploymentId, trustedApiOrigin, token, version, signal);
	try {
		await prime(resourceVersion);
		return resourceVersion;
	} catch (error) {
		if (!(error instanceof BillingApiError) || error.status !== 412) throw error;
	}

	signal.throwIfAborted();
	const deployment = await getDeployment(deploymentId);
	signal.throwIfAborted();
	await queryClient.cancelQueries({ queryKey: billingKeys.deployments, exact: true });
	signal.throwIfAborted();
	queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, (deployments) =>
		upsertAuthoritativeDeployment(deployments, deployment),
	);
	const freshVersion = deployment.resource.metadata.resourceVersion;
	await prime(freshVersion);
	return freshVersion;
}
