import { auth } from "@clerk/tanstack-react-start/server";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { AccountSuspensionBoundary } from "@/components/account-suspension-boundary";
import { useDashboardAuth } from "@/lib/auth-client";
import { useDesktopBridge } from "@/lib/desktop";
import { env } from "@/lib/env";

const getAuthState = createServerFn({ method: "GET" }).handler(async () => {
	setResponseHeader("cache-control", "no-store");
	if (env.VITE_DEV_AUTH_BYPASS) return { userId: "dev_browser" };
	const { userId } = await auth();
	return { userId };
});

export const Route = createFileRoute("/_protected")({
	beforeLoad: async ({ location }) => {
		if (typeof window !== "undefined" && window.clawdiDesktop) return;
		const { userId } = await getAuthState();
		if (!userId) {
			throw redirect({
				to: "/sign-in",
				search: { redirect_url: location.href },
			});
		}
	},
	component: ProtectedLayout,
});

function ProtectedLayout() {
	const desktopBridge = useDesktopBridge();
	const { isSignedIn } = useDashboardAuth();
	const authLoaded = isSignedIn !== undefined;
	const recoveryStarted = useRef(false);

	useEffect(() => {
		if (!desktopBridge || !authLoaded || isSignedIn || recoveryStarted.current) return;
		recoveryStarted.current = true;
		void desktopBridge.retryDashboard().catch(() => {
			recoveryStarted.current = false;
		});
	}, [authLoaded, desktopBridge, isSignedIn]);

	if (desktopBridge && (!authLoaded || !isSignedIn)) {
		return (
			<main className="flex min-h-dvh items-center justify-center bg-background">
				<LoaderCircle className="size-6 animate-spin text-muted-foreground" />
			</main>
		);
	}

	return (
		<AccountSuspensionBoundary>
			<Outlet />
		</AccountSuspensionBoundary>
	);
}
