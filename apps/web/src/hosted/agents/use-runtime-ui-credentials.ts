import type { RuntimeUiCredentials } from "@clawdi/shared/api";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { resolveRuntimeUiCredentials } from "@/hosted/agents/runtime-ui-credentials";
import { useBillingClient } from "@/hosted/billing/billing-client";
import type { HostedDeployment } from "@/hosted/billing/contracts";

/** Credentials belong to the mounted console, never to a cross-route cache. */
export function useRuntimeUiCredentials(deployment: HostedDeployment, endpoint: string | null) {
	const client = useBillingClient();
	const { id, metadata, spec } = deployment.resource;
	const [credentials, setCredentials] = useState<RuntimeUiCredentials | null>(null);
	const [error, setError] = useState<Error | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const pending = useRef<Promise<RuntimeUiCredentials | null> | null>(null);
	const active = useRef(false);
	const revision = useRef(0);
	const requested = useRef(false);

	useLayoutEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);

	const clear = useCallback(() => {
		revision.current += 1;
		pending.current = null;
		setCredentials(null);
		setError(null);
		setIsLoading(false);
	}, []);
	const load = useCallback(
		(fresh = false): Promise<RuntimeUiCredentials | null> => {
			if (!active.current || !endpoint) return Promise.resolve(null);
			if (pending.current) return pending.current;
			if (!fresh && credentials) return Promise.resolve(credentials);
			requested.current = true;
			const requestRevision = ++revision.current;
			setAttempt(requestRevision);
			setCredentials(null);
			setError(null);
			setIsLoading(true);
			const current = () => active.current && revision.current === requestRevision;
			pending.current = Promise.resolve()
				.then(async () => {
					if (!current()) return null;
					const result = await client.getRuntimeUiCredentials(id, metadata.resourceVersion);
					if (!current()) return null;
					const resolved = resolveRuntimeUiCredentials(result, endpoint, metadata.resourceVersion);
					if (!resolved || resolved.runtime !== spec.runtime)
						throw new Error("Invalid runtime access response.");
					setCredentials(resolved);
					return resolved;
				})
				.catch(() => {
					if (current()) setError(new Error("Clawdi couldn't load the browser sign-in details."));
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
		[client, id, metadata.resourceVersion, spec.runtime, endpoint, credentials],
	);

	useEffect(() => {
		if (spec.runtime === "openclaw" && endpoint && !requested.current) void load();
	}, [spec.runtime, endpoint, load]);

	return {
		credentials,
		error,
		isLoading,
		attempt,
		load: () => load(),
		clear,
		reconnect: () => load(true),
	};
}
