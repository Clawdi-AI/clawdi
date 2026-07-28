"use client";

import { useLocation, useMatch, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

/**
 * An async action captures the current location generation before it starts.
 * TanStack's `onBeforeNavigate` lifecycle revokes ownership for push, replace,
 * and pop before an outgoing route can complete its own async work. Unmount
 * also revokes ownership, including document exits.
 */
export function useLocationOwnership() {
	const router = useRouter();
	const generationRef = useRef(0);

	useEffect(() => {
		const unsubscribe = router.subscribe("onBeforeNavigate", ({ hrefChanged }) => {
			if (hrefChanged) generationRef.current += 1;
		});
		return () => {
			unsubscribe();
			generationRef.current += 1;
		};
	}, [router]);

	const capture = useCallback(() => generationRef.current, []);
	const isCurrent = useCallback((generation: number) => generationRef.current === generation, []);
	return { capture, isCurrent };
}

/** Whether the rendered leaf match still owns the Router's current pathname. */
export function useCurrentRouteOwnership(): boolean {
	const router = useRouter();
	const renderedRouteId = useMatch({ strict: false, select: (match) => match.routeId });
	const pathname = useLocation({ select: (location) => location.pathname });
	return router.getMatchedRoutes(pathname).foundRoute?.id === renderedRouteId;
}
