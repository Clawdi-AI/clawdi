import type { RuntimeUiCredentials } from "@clawdi/shared/api";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { primeHermesOidcBrowserSession } from "@/hosted/agents/hermes-oidc-browser-session";
import { primeOpenClawBrowserSession } from "@/hosted/agents/openclaw-browser-session";
import {
	forgetOpenClawNativeHandoffLoaded,
	hasOpenClawNativeHandoffLoaded,
	markOpenClawNativeHandoffLoaded,
	resolveRuntimeUiCredentials,
	runtimeUiLocalStorage,
} from "@/hosted/agents/runtime-ui-credentials";
import { BILLING_API_ORIGIN, useBillingClient } from "@/hosted/billing/billing-client";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { useAuthToken, useSessionIdentity } from "@/lib/auth-client";

/** Credentials and OIDC priming belong to the mounted console, never to a cross-route cache. */
export function useRuntimeUiCredentials(deployment: HostedDeployment, endpoint: string | null) {
	const client = useBillingClient();
	const { id, metadata, spec } = deployment.resource;
	const identity = useSessionIdentity();
	const { getToken } = useAuthToken();
	const runtimeEndpoint = deployment.runtime_ui_endpoint;
	const openClawBrowserSessionUrl =
		runtimeEndpoint?.runtime === "openclaw" ? runtimeEndpoint.browser_session_url : null;
	const hermesOidcBrowserSessionUrl =
		runtimeEndpoint?.runtime === "hermes" && runtimeEndpoint.auth_mode === "oidc"
			? runtimeEndpoint.browser_session_url
			: null;
	const isHermesOidc = hermesOidcBrowserSessionUrl != null;
	const storageScope = JSON.stringify([identity, id]);
	const authorityIdentity = JSON.stringify([
		identity,
		id,
		metadata.resourceVersion,
		endpoint,
		hermesOidcBrowserSessionUrl,
	]);
	const [nativeHandoffLoaded, setNativeHandoffLoaded] = useState(false);
	const [hermesOidcPrimedAuthority, setHermesOidcPrimedAuthority] = useState<string | null>(null);
	const hermesOidcPrimed = isHermesOidc && hermesOidcPrimedAuthority === authorityIdentity;
	const [credentials, setCredentials] = useState<RuntimeUiCredentials | null>(null);
	const [error, setError] = useState<Error | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const pending = useRef<Promise<RuntimeUiCredentials | null> | null>(null);
	const active = useRef(false);
	const revision = useRef(0);
	const requestedVersion = useRef<string | null>(null);
	const requestAbort = useRef<AbortController | null>(null);
	const mountedAuthorityIdentity = useRef(authorityIdentity);

	useLayoutEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
			requestAbort.current?.abort();
		};
	}, []);

	const clear = useCallback(() => {
		requestAbort.current?.abort();
		forgetOpenClawNativeHandoffLoaded(runtimeUiLocalStorage(), storageScope);
		setNativeHandoffLoaded(false);
		setHermesOidcPrimedAuthority(null);
		revision.current += 1;
		pending.current = null;
		requestedVersion.current = null;
		setCredentials(null);
		setError(null);
		setIsLoading(false);
	}, [storageScope]);

	useEffect(() => {
		if (mountedAuthorityIdentity.current === authorityIdentity) return;
		mountedAuthorityIdentity.current = authorityIdentity;
		clear();
	}, [authorityIdentity, clear]);

	const load = useCallback(
		(fresh = false): Promise<RuntimeUiCredentials | null> => {
			if (!active.current || !endpoint) return Promise.resolve(null);
			if (pending.current) return pending.current;
			if (isHermesOidc && !fresh && hermesOidcPrimed) return Promise.resolve(null);
			if (!fresh && credentials) return Promise.resolve(credentials);
			if (fresh) {
				forgetOpenClawNativeHandoffLoaded(runtimeUiLocalStorage(), storageScope);
				setNativeHandoffLoaded(false);
				setHermesOidcPrimedAuthority(null);
			}
			requestedVersion.current = metadata.resourceVersion;
			const requestRevision = ++revision.current;
			setAttempt(requestRevision);
			setCredentials(null);
			setError(null);
			setIsLoading(true);
			const current = () => active.current && revision.current === requestRevision;
			pending.current = Promise.resolve()
				.then(async () => {
					if (!current()) return null;
					const abort = new AbortController();
					requestAbort.current?.abort();
					requestAbort.current = abort;
					if (hermesOidcBrowserSessionUrl) {
						const token = await getToken();
						if (!current()) return null;
						await primeHermesOidcBrowserSession(
							hermesOidcBrowserSessionUrl,
							id,
							BILLING_API_ORIGIN,
							token,
							metadata.resourceVersion,
							abort.signal,
						);
						if (!current()) return null;
						setHermesOidcPrimedAuthority(authorityIdentity);
						return null;
					}
					if (openClawBrowserSessionUrl) {
						const token = await getToken();
						if (!current()) return null;
						await primeOpenClawBrowserSession(
							openClawBrowserSessionUrl,
							endpoint,
							token,
							metadata.resourceVersion,
							abort.signal,
						);
						if (!current()) return null;
					}
					if (
						!fresh &&
						spec.runtime === "openclaw" &&
						hasOpenClawNativeHandoffLoaded(
							runtimeUiLocalStorage(),
							storageScope,
							endpoint,
							metadata.generation,
						)
					) {
						setNativeHandoffLoaded(true);
						return null;
					}
					const result = await client.getRuntimeUiCredentials(id, metadata.resourceVersion);
					if (!current()) return null;
					const resolved = resolveRuntimeUiCredentials(result, endpoint, metadata.resourceVersion);
					if (!resolved || resolved.runtime !== spec.runtime)
						throw new Error("Invalid runtime access response.");
					setCredentials(resolved);
					return resolved;
				})
				.catch(() => {
					if (current()) {
						setHermesOidcPrimedAuthority(null);
						setError(
							new Error(
								isHermesOidc
									? "Clawdi couldn't establish this browser session."
									: "Clawdi couldn't load the browser sign-in details.",
							),
						);
					}
					return null;
				})
				.finally(() => {
					if (current()) {
						pending.current = null;
						setIsLoading(false);
					}
				});
			return pending.current;
		},
		[
			client,
			id,
			metadata.resourceVersion,
			metadata.generation,
			spec.runtime,
			endpoint,
			credentials,
			storageScope,
			openClawBrowserSessionUrl,
			hermesOidcBrowserSessionUrl,
			hermesOidcPrimed,
			isHermesOidc,
			authorityIdentity,
			getToken,
		],
	);

	useEffect(() => {
		const shouldPrimeOpenClaw = spec.runtime === "openclaw" && !nativeHandoffLoaded;
		const shouldPrimeHermes = isHermesOidc && !hermesOidcPrimed;
		if (
			endpoint &&
			(shouldPrimeOpenClaw || shouldPrimeHermes) &&
			!credentials &&
			!isLoading &&
			requestedVersion.current !== metadata.resourceVersion
		) {
			void load();
		}
	}, [
		spec.runtime,
		endpoint,
		metadata.resourceVersion,
		metadata.generation,
		credentials,
		isLoading,
		load,
		nativeHandoffLoaded,
		hermesOidcPrimed,
		isHermesOidc,
	]);

	return {
		credentials,
		error,
		isLoading,
		attempt,
		nativeHandoffLoaded,
		hermesOidcPrimed,
		markFrameLoaded: () => {
			if (
				active.current &&
				revision.current === attempt &&
				endpoint &&
				markOpenClawNativeHandoffLoaded(
					runtimeUiLocalStorage(),
					storageScope,
					endpoint,
					credentials,
					metadata.generation,
				)
			)
				setNativeHandoffLoaded(true);
		},
		load: () => load(),
		clear,
		reconnect: () => load(true),
	};
}
