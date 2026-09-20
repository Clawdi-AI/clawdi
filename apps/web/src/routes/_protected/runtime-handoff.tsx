import { createFileRoute } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { primeHermesOidcBrowserSession } from "@/hosted/agents/hermes-oidc-browser-session";
import { BILLING_API_ORIGIN, useBillingClient } from "@/hosted/billing/billing-client";
import { hermesOidcLoginUrl } from "@/hosted/runtimes";
import { useAuthToken } from "@/lib/auth-client";

function validateRuntimeHandoffSearch(search: Record<string, unknown>) {
	const deploymentId = search.deployment_id;
	if (typeof deploymentId !== "string" || !/^hdep_[A-Za-z0-9]{8,}$/.test(deploymentId)) {
		throw new Error("Invalid runtime handoff.");
	}
	return { deployment_id: deploymentId };
}

export const Route = createFileRoute("/_protected/runtime-handoff")({
	validateSearch: validateRuntimeHandoffSearch,
	head: () => ({ meta: [{ title: "Opening Hermes · Clawdi" }] }),
	component: RuntimeHandoffPage,
});

function RuntimeHandoffPage() {
	const { deployment_id: deploymentId } = Route.useSearch();
	const client = useBillingClient();
	const { getToken } = useAuthToken();
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const controller = new AbortController();
		let cancelled = false;

		void (async () => {
			try {
				const deployment = await client.getDeployment(deploymentId);
				const endpoint = deployment.runtime_ui_endpoint;
				if (
					endpoint?.runtime !== "hermes" ||
					endpoint?.role !== "control_ui" ||
					endpoint?.auth_mode !== "oidc" ||
					!endpoint?.browser_session_url
				) {
					throw new Error("Hermes OIDC is unavailable.");
				}
				const returnUrl = hermesOidcLoginUrl(endpoint.url);
				if (returnUrl === endpoint.url) throw new Error("Hermes login URL is unavailable.");
				const token = await getToken();
				await primeHermesOidcBrowserSession(
					endpoint.browser_session_url,
					deployment.resource.id,
					BILLING_API_ORIGIN,
					token,
					deployment.resource.metadata.resourceVersion,
					controller.signal,
				);
				if (!cancelled) window.location.replace(returnUrl);
			} catch {
				if (!cancelled) setFailed(true);
			}
		})();

		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [client, deploymentId, getToken]);

	return (
		<main className="flex min-h-dvh items-center justify-center p-6">
			<div className="flex max-w-sm flex-col items-center gap-3 text-center">
				{failed ? (
					<>
						<h1 className="text-lg font-semibold">Hermes couldn&apos;t be opened</h1>
						<p className="text-sm text-muted-foreground">
							Your sign-in is valid, but this deployment is not ready for OIDC login.
						</p>
					</>
				) : (
					<>
						<LoaderCircle className="animate-spin" />
						<p className="text-sm text-muted-foreground">Opening Hermes…</p>
					</>
				)}
			</div>
		</main>
	);
}
