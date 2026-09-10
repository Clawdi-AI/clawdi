"use client";

import { createContext, Fragment, useContext, useState, useSyncExternalStore } from "react";
import { AccountSuspendedPage } from "@/components/account-suspended-page";
import { AuthStatus } from "@/components/auth-status";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { useAccountSuspension } from "@/lib/account-suspension";
import { useOpenApi } from "@/lib/api";
import { isAccountSuspendedError, isApiAuthError } from "@/lib/api-errors";
import { useAuthActions } from "@/lib/auth-client";

const AccountDataContext = createContext<{
	identity: string | null;
	fallback: React.ReactNode;
}>({ identity: null, fallback: <RouteLoadingSkeleton /> });

export function useAccountDataIdentity() {
	return useContext(AccountDataContext).identity;
}

export function AccountDataBoundary({ children }: { children: React.ReactNode }) {
	const { identity, fallback } = useContext(AccountDataContext);
	return identity ? <Fragment key={identity}>{children}</Fragment> : fallback;
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
	if (identity && (suspended || isAccountSuspendedError(access.error))) {
		admitted = null;
		fallback = <AccountAccessDeniedState suspended />;
	} else if (identity && isApiAuthError(access.error)) {
		admitted = null;
		fallback = <AccountAccessDeniedState suspended={false} />;
	} else if (identity && access.isError) {
		admitted = null;
		fallback = <AuthStatus status="unavailable" />;
	}
	return (
		<AccountDataContext value={{ identity: admitted, fallback }}>{children}</AccountDataContext>
	);
}

function AccountAccessDeniedState({ suspended }: { suspended: boolean }) {
	const { signOut } = useAuthActions();
	const [signingOut, setSigningOut] = useState(false);
	const [signOutError, setSignOutError] = useState<string | null>(null);

	const handleSignOut = async () => {
		setSigningOut(true);
		setSignOutError(null);
		try {
			await signOut({ redirectUrl: "/sign-in" });
		} catch {
			setSignOutError("We couldn't sign you out. Please try again.");
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
