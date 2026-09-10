import { auth } from "@clerk/tanstack-react-start/server";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { ProtectedAuthBoundary, ProtectedRouteError } from "@/components/protected-auth-boundary";
import { env } from "@/lib/env";
import { type RouteAuth, requireRouteIdentity } from "@/lib/route-auth";

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
		const { userId, sessionId } = await getAuthState();
		const serverAuth: RouteAuth =
			userId && sessionId ? { status: "signed-in", userId, sessionId } : { status: "signed-out" };
		return { authIdentity: requireRouteIdentity(serverAuth, location.href) };
	},
	errorComponent: ProtectedRouteError,
	component: ProtectedLayout,
});

function ProtectedLayout() {
	const { authIdentity } = Route.useRouteContext();
	return (
		<ProtectedAuthBoundary identity={authIdentity}>
			<Outlet />
		</ProtectedAuthBoundary>
	);
}
