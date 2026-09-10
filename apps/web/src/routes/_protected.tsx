import { auth } from "@clerk/tanstack-react-start/server";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { AuthStatus } from "@/components/auth-status";
import { ProtectedAuthBoundary } from "@/components/protected-auth-boundary";
import RootError from "@/components/root-error";
import { useRouteAuth, useSessionIdentity } from "@/lib/auth-client";
import { env } from "@/lib/env";
import { requireRouteIdentity } from "@/lib/route-auth";

const getAuthState = createServerFn({ method: "GET" }).handler(async () => {
	setResponseHeader("cache-control", "no-store");
	if (env.VITE_DEV_AUTH_BYPASS) {
		return { userId: "dev_browser", sessionId: "dev_browser_session" };
	}
	const { userId, sessionId } = await auth();
	return { userId, sessionId };
});

export const Route = createFileRoute("/_protected")({
	beforeLoad: async ({ location }) => {
		if (env.VITE_CLAWDI_DESKTOP_BUILD) return { authIdentity: null };
		return { authIdentity: requireRouteIdentity(await getAuthState(), location.href) };
	},
	errorComponent: RootError,
	component: ProtectedLayout,
});

function ProtectedLayout() {
	const { authIdentity } = Route.useRouteContext();
	if (env.VITE_CLAWDI_DESKTOP_BUILD) return <DesktopProtectedLayout />;
	if (!authIdentity) return <AuthStatus status="signed-out" />;
	return (
		<ProtectedAuthBoundary identity={authIdentity}>
			<Outlet />
		</ProtectedAuthBoundary>
	);
}

function DesktopProtectedLayout() {
	const auth = useRouteAuth();
	const identity = useSessionIdentity();
	if (!identity || auth.status !== "signed-in") {
		return <AuthStatus status={auth.status === "signed-in" ? "loading" : auth.status} />;
	}
	return (
		<ProtectedAuthBoundary identity={identity}>
			<Outlet />
		</ProtectedAuthBoundary>
	);
}
