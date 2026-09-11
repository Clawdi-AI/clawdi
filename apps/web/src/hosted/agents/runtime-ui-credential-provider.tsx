"use client";

import { useLocation } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useSyncExternalStore,
} from "react";
import {
	createRuntimeUiCredentialSession,
	type RuntimeUiCredentialSession,
} from "@/hosted/agents/runtime-ui-credential-session";
import {
	forgetOpenClawNativeHandoffLoaded,
	hasOpenClawNativeHandoffLoaded,
	markOpenClawNativeHandoffLoaded,
	resolveRuntimeUiCredentials,
	runtimeUiLocalStorage,
} from "@/hosted/agents/runtime-ui-credentials";
import { useBillingClient } from "@/hosted/billing/billing-client";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { deploymentRuntimeUiIsReady } from "@/hosted/deployment-status";
import { runtimeConsoleUrl } from "@/hosted/runtimes";
import { parseAgentPathname } from "@/lib/agent-routes";
import { useSessionIdentity } from "@/lib/auth-client";
import { runtimeBrowserUiLabel } from "@/lib/navigation-model";

const CredentialContext = createContext<RuntimeUiCredentialSession | null>(null);

export function RuntimeUiCredentialProvider({
	deployment,
	children,
}: {
	deployment?: HostedDeployment | null;
	children: ReactNode;
}) {
	const consoleActive = useLocation({
		select: (location) => parseAgentPathname(location.pathname)?.section === "console",
	});
	const client = useBillingClient();
	const identity = useSessionIdentity();
	const id = deployment?.resource.id;
	const generation = deployment?.resource.metadata.generation;
	const resourceVersion = deployment?.resource.metadata.resourceVersion;
	const runtime = deployment?.resource.spec.runtime;
	const ready = Boolean(identity && deployment && deploymentRuntimeUiIsReady(deployment));
	const endpoint = ready && deployment ? runtimeConsoleUrl(deployment) : null;
	const session = useMemo(
		() =>
			createRuntimeUiCredentialSession({
				request: async () => {
					if (!identity || !ready || !endpoint || !id || !resourceVersion || !runtime)
						throw new Error("The agent browser interface isn't ready yet.");
					const credentials = await client.getRuntimeUiCredentials(id, resourceVersion);
					const resolved = resolveRuntimeUiCredentials(credentials, endpoint, resourceVersion);
					if (!resolved || resolved.runtime !== runtime)
						throw new Error(
							`Clawdi couldn't load the ${runtimeBrowserUiLabel(runtime)} sign-in details.`,
						);
					return resolved;
				},
				hasNativeHandoffLoaded: () =>
					Boolean(
						runtime === "openclaw" &&
							id &&
							endpoint &&
							generation !== undefined &&
							hasOpenClawNativeHandoffLoaded(runtimeUiLocalStorage(), id, endpoint, generation),
					),
				markNativeHandoffLoaded: (credentials) => {
					if (id && endpoint && generation !== undefined)
						markOpenClawNativeHandoffLoaded(
							runtimeUiLocalStorage(),
							id,
							endpoint,
							credentials,
							generation,
						);
				},
				forgetNativeHandoffLoaded: () => {
					if (id) forgetOpenClawNativeHandoffLoaded(runtimeUiLocalStorage(), id);
				},
			}),
		[client, identity, id, generation, resourceVersion, runtime, ready, endpoint],
	);

	// Retire the previous identity before child effects can use its credentials.
	useLayoutEffect(() => {
		session.activate();
		return () => session.dispose();
	}, [session]);
	useEffect(() => {
		if (runtime !== "openclaw" || !ready || !endpoint) return;
		if (consoleActive) void session.open();
		else {
			session.leave();
			void session.preload();
		}
	}, [session, runtime, ready, endpoint, consoleActive]);

	return <CredentialContext value={session}>{children}</CredentialContext>;
}

export function useRuntimeUiCredentialSession() {
	const session = useContext(CredentialContext);
	if (!session) throw new Error("Runtime UI credentials require an agent route owner.");
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	return { session, state };
}
