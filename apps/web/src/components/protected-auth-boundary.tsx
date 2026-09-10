import type { ErrorComponentProps } from "@tanstack/react-router";
import { AccountSuspensionBoundary } from "@/components/account-suspension-boundary";
import { AuthStatus } from "@/components/auth-status";
import RootError from "@/components/root-error";
import { useRouteAuth, useSessionIdentity } from "@/lib/auth-client";
import { RouteAuthUnavailable, routeAuthIdentity } from "@/lib/route-auth";

export function ProtectedRouteError({ error, reset }: ErrorComponentProps) {
	return error instanceof RouteAuthUnavailable ? (
		<AuthStatus status={error.status} />
	) : (
		<RootError error={error} reset={reset} />
	);
}

export function ProtectedAuthBoundary({
	identity: admittedIdentity,
	children,
}: {
	identity: string;
	children: React.ReactNode;
}) {
	const auth = useRouteAuth();
	const sessionIdentity = useSessionIdentity();
	const identity = routeAuthIdentity(auth);
	const ready = sessionIdentity === admittedIdentity && identity === admittedIdentity;
	// A settled disagreement is recoverable, not an endless activation skeleton.
	const status =
		auth.status !== "signed-in"
			? auth.status
			: sessionIdentity && identity !== admittedIdentity
				? "unavailable"
				: "loading";
	return (
		<AccountSuspensionBoundary identity={ready ? identity : null} status={status}>
			{children}
		</AccountSuspensionBoundary>
	);
}
