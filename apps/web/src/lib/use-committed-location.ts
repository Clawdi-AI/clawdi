"use client";

import { useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";

/**
 * The location of the route tree React is *actually rendering*.
 *
 * TanStack Router swaps `state.location` the moment a navigation starts
 * (`beforeLoad`), while the rendered route components keep coming from
 * `state.matches` until the next route has loaded. A mounted page that
 * reads the global location during that pending window pairs the new URL
 * with the old page — links, tabs, and effect-driven redirects all derive
 * from a route the user is navigating away from. Selecting from the
 * committed match tree keeps every reader consistent with the visible
 * page; both flip atomically when the navigation commits.
 */
export function useCommittedLocation() {
	const pathname = useRouterState({
		select: (state) => state.matches.at(-1)?.pathname ?? state.location.pathname,
	});
	const search = useRouterState({
		select: (state) => state.matches.at(-1)?.search ?? state.location.search,
	});
	return useMemo(() => ({ pathname, search }), [pathname, search]);
}

/**
 * True only while the latest navigation target still resolves to the route
 * this component is mounted for. Effect-driven redirects (URL
 * canonicalizers) must gate on this: async data resolving during an
 * unrelated pending navigation would otherwise `router.navigate` over the
 * user's in-flight destination. Compared on pathname — the committed leaf
 * match is always this page while mounted, so equality with the latest
 * target pathname means no navigation away is in flight.
 */
export function useCommittedRouteIsLatestTarget(): boolean {
	return useRouterState({
		select: (state) =>
			(state.matches.at(-1)?.pathname ?? state.location.pathname) === state.location.pathname,
	});
}
