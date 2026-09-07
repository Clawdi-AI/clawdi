import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider, useRouter } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clearAccountSuspension } from "@/lib/account-suspension";
import { useRouteAuth } from "@/lib/auth-client";
import { createAppQueryClient } from "@/lib/query-client";
import { routeAuthIdentity } from "@/lib/route-auth";

const isProtectedMatch = (match: { routeId: string }) => match.routeId.startsWith("/_protected");

export function AuthRouterBridge({ children }: { children: React.ReactNode }) {
	const router = useRouter();
	const auth = useRouteAuth();
	const identity = routeAuthIdentity(auth);
	const authKey = identity ?? auth.status;
	const previousAuthKey = useRef<string | undefined>(undefined);
	const [scope, setScope] = useState(() => ({ identity, queryClient: createAppQueryClient() }));
	if (scope.identity !== identity) {
		// React retries this render before children commit. Old requests and
		// mutation callbacks retain their old client, never the next session's.
		setScope({ identity, queryClient: createAppQueryClient() });
	}
	useEffect(() => () => scope.queryClient.clear(), [scope.queryClient]);
	useLayoutEffect(() => {
		if (previousAuthKey.current === authKey) return;
		previousAuthKey.current = authKey;
		clearAccountSuspension();
		router.clearCache({ filter: isProtectedMatch });
		if (
			![...router.state.matches, ...router.matchRoutes(router.state.location)].some(
				isProtectedMatch,
			)
		) {
			return;
		}
		void router
			.invalidate({ filter: isProtectedMatch })
			.catch(() => console.error("Failed to refresh authenticated routes"));
	}, [authKey, router]);

	return (
		<RouterContextProvider router={router} context={{ auth }}>
			<QueryClientProvider client={scope.queryClient}>{children}</QueryClientProvider>
		</RouterContextProvider>
	);
}
