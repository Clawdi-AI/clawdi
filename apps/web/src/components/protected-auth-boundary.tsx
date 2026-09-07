import type { ErrorComponentProps } from "@tanstack/react-router";
import { Fragment } from "react";
import { AuthStatus } from "@/components/auth-status";
import RootError from "@/components/root-error";
import { useRouteAuth } from "@/lib/auth-client";
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
	const identity = routeAuthIdentity(auth);
	if (auth.status !== "signed-in") return <AuthStatus status={auth.status} />;
	// Cached/in-flight matches cannot render under a different live session.
	if (identity !== admittedIdentity) return <AuthStatus status="loading" />;
	return <Fragment key={identity}>{children}</Fragment>;
}
