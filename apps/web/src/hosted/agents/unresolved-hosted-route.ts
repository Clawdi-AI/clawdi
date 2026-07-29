"use client";

import { useEffect, useState } from "react";

export const UNRESOLVED_HOSTED_ROUTE_GRACE_MS = 2 * 60_000;

/** Keep an accepted hosted route in neutral loading chrome while inventory converges. */
export function useUnresolvedHostedRouteGrace(routeKey: string | null): boolean {
	const [graceState, setGraceState] = useState<{ expired: boolean; routeKey: string | null }>({
		expired: false,
		routeKey,
	});

	useEffect(() => {
		setGraceState({ expired: false, routeKey });
		if (!routeKey || typeof window === "undefined") return;
		const timeoutId = window.setTimeout(
			() => setGraceState({ expired: true, routeKey }),
			UNRESOLVED_HOSTED_ROUTE_GRACE_MS,
		);
		return () => window.clearTimeout(timeoutId);
	}, [routeKey]);

	return Boolean(routeKey && (graceState.routeKey !== routeKey || !graceState.expired));
}
