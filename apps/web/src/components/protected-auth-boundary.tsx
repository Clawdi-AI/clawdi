import { AccountSuspensionBoundary } from "@/components/account-suspension-boundary";
import { useRouteAuth, useSessionIdentity } from "@/lib/auth-client";
import { routeAuthIdentity } from "@/lib/route-auth";

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
