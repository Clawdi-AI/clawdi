"use client";

import { useState, useSyncExternalStore } from "react";
import { AccountSuspendedPage } from "@/components/account-suspended-page";
import { AuthStatus } from "@/components/auth-status";
import {
	getAccountSuspendedServerSnapshot,
	getAccountSuspendedSnapshot,
	subscribeToAccountSuspension,
} from "@/lib/account-suspension";
import { useOpenApi } from "@/lib/api";
import { isAccountSuspendedError, isApiAuthError } from "@/lib/api-errors";
import { useAuthActions, useCurrentUser } from "@/lib/auth-client";
import { useHydrated } from "@/lib/use-hydrated";

export function AccountSuspensionBoundary({ children }: { children: React.ReactNode }) {
	const hydrated = useHydrated();
	const { isLoaded, isSignedIn } = useCurrentUser();
	const suspended = useSyncExternalStore(
		subscribeToAccountSuspension,
		getAccountSuspendedSnapshot,
		getAccountSuspendedServerSnapshot,
	);
	const api = useOpenApi();
	const accessCheckEnabled = hydrated && isLoaded && Boolean(isSignedIn);
	const access = api.useQuery(
		"get",
		"/v1/auth/me",
		{},
		{
			enabled: accessCheckEnabled,
			retry: false,
			staleTime: Number.POSITIVE_INFINITY,
			refetchOnWindowFocus: false,
		},
	);

	if (suspended || isAccountSuspendedError(access.error)) {
		return <AccountAccessDeniedState suspended />;
	}
	if (isApiAuthError(access.error)) return <AccountAccessDeniedState suspended={false} />;
	if (access.isError) return <AuthStatus status="unavailable" />;
	return children;
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
