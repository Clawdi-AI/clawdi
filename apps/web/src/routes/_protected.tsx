import { auth } from "@clerk/tanstack-react-start/server";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { AuthStatus } from "@/components/auth-status";
import { ProtectedAuthBoundary } from "@/components/protected-auth-boundary";
import RootError from "@/components/root-error";
import { ApiNetworkError } from "@/lib/api-errors";
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

const loadProtectedRoute = async ({ location }: { location: { href: string } }) => {
	const authState = await getAuthState({
		// Navigation can outlive the connection; classify the transport
		// failure so the error boundary does not report it as an app fault.
		fetch: (input, init) =>
			fetch(input, init).catch((cause: unknown) => {
				throw new ApiNetworkError("offline", { cause });
			}),
	});
	return {
		authIdentity: requireRouteIdentity(
			authState,
			location.href,
			env.VITE_CLAWDI_HOSTED ? env.VITE_CLAWDI_MARKETING_URL : undefined,
		),
	};
};

export const Route = createFileRoute("/_protected")({
	beforeLoad: loadProtectedRoute,
	errorComponent: RootError,
	component: ProtectedLayout,
});

function ProtectedLayout() {
	const { authIdentity } = Route.useRouteContext();
	if (!authIdentity) return <AuthStatus status="signed-out" />;
	return (
		<ProtectedAuthBoundary identity={authIdentity}>
			<Outlet />
		</ProtectedAuthBoundary>
	);
}
