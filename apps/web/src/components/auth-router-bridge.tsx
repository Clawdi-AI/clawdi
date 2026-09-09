import { QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AccountSuspensionContext, createAccountSuspensionStore } from "@/lib/account-suspension";
import { useRouteAuth } from "@/lib/auth-client";
import { createAppQueryClient } from "@/lib/query-client";
import { routeAuthIdentity } from "@/lib/route-auth";

const isProtectedMatch = (match: { routeId: string }) => match.routeId.startsWith("/_protected");

export function AuthRouterBridge({ children }: { children: React.ReactNode }) {
	const router = useRouter();
	const auth = useRouteAuth();
	const identity = routeAuthIdentity(auth);
	const authKey = identity ?? auth.status;
	// Hydration restores beforeLoad context. Use that admission as the baseline,
	// so the first live snapshot still revalidates a different user or sign-out.
	const admittedMatch = router.state.matches.find((match) => match.routeId === "/_protected");
	const previousAuthKey = useRef(
		admittedMatch?.status === "success" ? admittedMatch.context.authIdentity : undefined,
	);
	const previouslySignedIn = useRef(false);
	const [scope, setScope] = useState(() => ({
		identity,
		queryClient: createAppQueryClient(),
		suspension: createAccountSuspensionStore(),
	}));
	if (scope.identity !== identity) {
		// React retries this render before children commit. Old requests and
		// mutation callbacks retain their old client, never the next session's.
		setScope({
			identity,
			queryClient: createAppQueryClient(),
			suspension: createAccountSuspensionStore(),
		});
	}
	useEffect(() => () => scope.queryClient.clear(), [scope.queryClient]);
	useLayoutEffect(() => {
		if (auth.status === "loading" || auth.status === "unavailable") return;
		if (previousAuthKey.current === authKey) return;
		const hadSession = previouslySignedIn.current;
		if (auth.status === "signed-in" || auth.status === "signed-out") {
			previouslySignedIn.current = auth.status === "signed-in";
		}
		previousAuthKey.current = authKey;
		if (hadSession && auth.status === "signed-out" && window.clawdiDesktop) {
			void window.clawdiDesktop
				.retryDashboard()
				.catch(() => console.error("Failed to restore Desktop sign-in"));
		}
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
	}, [authKey, auth.status, router]);

	return (
		<AccountSuspensionContext value={scope.suspension}>
			<QueryClientProvider client={scope.queryClient}>{children}</QueryClientProvider>
		</AccountSuspensionContext>
	);
}
