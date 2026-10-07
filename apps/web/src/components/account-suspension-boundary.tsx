"use client";

import { accountSuspendedCopy } from "@clawdi/shared/view";
import { useRouterState } from "@tanstack/react-router";
import { createContext, Fragment, useContext, useState, useSyncExternalStore } from "react";
import { AccountSuspendedPage } from "@/components/account-suspended-page";
import { AuthStatus } from "@/components/auth-status";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { useAccountSuspension } from "@/lib/account-suspension";
import { useOpenApi } from "@/lib/api";
import { isAccountSuspendedError, isApiAuthError } from "@/lib/api-errors";
import { useAuthActions } from "@/lib/auth-client";
import { signInActionHref } from "@/lib/auth-redirect";

const AccountDataContext = createContext<{
	identity: string | null;
	loading: boolean;
	fallback: React.ReactNode;
}>({ identity: null, loading: true, fallback: <RouteLoadingSkeleton /> });

export function useAccountDataIdentity() {
	return useContext(AccountDataContext).identity;
}

/** `loadingFallback` lets a route show its own skeleton while auth resolves,
 * so the generic placeholder doesn't precede the page's skeleton. */
export function AccountDataBoundary({
	children,
	loadingFallback,
}: {
	children: React.ReactNode;
	loadingFallback?: React.ReactNode;
}) {
	const { identity, loading, fallback } = useContext(AccountDataContext);
	if (identity) return <Fragment key={identity}>{children}</Fragment>;
	return loading && loadingFallback ? loadingFallback : fallback;
}

// The admission result controls private regions, not the surrounding layout.
export function AccountSuspensionBoundary({
	identity,
	status,
	children,
}: {
	identity: string | null;
	status: "loading" | "unavailable" | "signed-out";
	children: React.ReactNode;
}) {
	const store = useAccountSuspension();
	const suspended = useSyncExternalStore(store.subscribe, store.getSnapshot, () => false);
	const api = useOpenApi();
	const access = api.useQuery(
		"get",
		"/v1/auth/me",
		{},
		{
			enabled: Boolean(identity),
			retry: false,
			staleTime: Number.POSITIVE_INFINITY,
			refetchOnWindowFocus: false,
		},
	);
	let fallback: React.ReactNode =
		status === "loading" ? <RouteLoadingSkeleton /> : <AuthStatus status={status} />;
	let admitted = identity;
	let loading = status === "loading";
	if (identity && (suspended || isAccountSuspendedError(access.error))) {
		admitted = null;
		loading = false;
		fallback = <AccountAccessDeniedState suspended />;
	} else if (identity && isApiAuthError(access.error)) {
		admitted = null;
		loading = false;
		fallback = <AccountAccessDeniedState suspended={false} />;
	} else if (identity && access.isError) {
		admitted = null;
		loading = false;
		fallback = <AuthStatus status="unavailable" />;
	}
	return (
		<AccountDataContext value={{ identity: admitted, loading, fallback }}>
			{children}
		</AccountDataContext>
	);
}

function AccountAccessDeniedState({ suspended }: { suspended: boolean }) {
	const href = useRouterState({ select: (state) => state.location.href });
	const { signOut } = useAuthActions();
	const [signingOut, setSigningOut] = useState(false);
	const [signOutError, setSignOutError] = useState<string | null>(null);

	const handleSignOut = async () => {
		setSigningOut(true);
		setSignOutError(null);
		try {
			// API reauthentication must retire the stale identity. The auth bridge
			// then re-runs protected admission; use its secure dedicated login fallback.
			await signOut({ redirectUrl: suspended ? "/sign-in" : signInActionHref(href) });
		} catch {
			setSignOutError(accountSuspendedCopy.signOutFailed);
			setSigningOut(false);
		}
	};

	if (!suspended) {
		return (
			<AuthStatus
				status="signed-out"
				onSignIn={() => void handleSignOut()}
				signingIn={signingOut}
				error={signOutError}
			/>
		);
	}
	return (
		<AccountSuspendedPage
			onSignOut={() => void handleSignOut()}
			signingOut={signingOut}
			signOutError={signOutError}
		/>
	);
}
