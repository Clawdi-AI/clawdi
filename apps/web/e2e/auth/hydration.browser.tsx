import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { hydrate } from "@tanstack/react-router/ssr/client";
import { useLayoutEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { AccountDataBoundary } from "@/components/account-suspension-boundary";
import { AuthRouterBridge } from "@/components/auth-router-bridge";
import { ProtectedAuthBoundary } from "@/components/protected-auth-boundary";
import RootError from "@/components/root-error";
import { requireRouteIdentity } from "@/lib/route-auth";
import { useHydrated } from "@/lib/use-hydrated";
import { emitSdk, serverAuth as readServerAuth } from "./clerk-fixture";

const serverAuth = { userId: "user-a", sessionId: "session-a" };
let admissions = 0;
const errors: string[] = [];
let hydrated = false;

function HydrationProbe() {
	const isHydrated = useHydrated();
	useLayoutEffect(() => {
		hydrated = isHydrated;
	});
	return <Outlet />;
}

function DocumentProbe() {
	return (
		<iframe
			title="SSR runtime"
			srcDoc="<!doctype html><textarea aria-label='Runtime draft'></textarea>"
		/>
	);
}

function createProbeRouter(isServer: boolean) {
	const root = createRootRoute({
		component: () => (
			<AuthRouterBridge>
				<HydrationProbe />
			</AuthRouterBridge>
		),
	});
	const protectedRoute = createRoute({
		getParentRoute: () => root,
		id: "_protected",
		beforeLoad: ({ location }) => {
			admissions += 1;
			return {
				authIdentity: requireRouteIdentity(isServer ? serverAuth : readServerAuth(), location.href),
			};
		},
		errorComponent: RootError,
		component: () => (
			<ProtectedAuthBoundary identity={protectedRoute.useRouteContext().authIdentity}>
				<header>
					<h1>Server-admitted document</h1>
				</header>
				<AccountDataBoundary>
					<Outlet />
				</AccountDataBoundary>
			</ProtectedAuthBoundary>
		),
	});
	const index = createRoute({
		getParentRoute: () => protectedRoute,
		path: "/",
		component: DocumentProbe,
	});
	const signIn = createRoute({
		getParentRoute: () => root,
		path: "/sign-in",
		component: () => <h1>Sign in</h1>,
	});
	const router = createRouter({
		routeTree: root.addChildren([protectedRoute.addChildren([index]), signIn]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
		isServer,
	});
	return router;
}

export async function renderHydrationProbe() {
	const { renderToString } = await import("react-dom/server");
	const { attachRouterServerSsrUtils } = await import("@tanstack/react-router/ssr/server");
	const router = createProbeRouter(true);
	attachRouterServerSsrUtils({ router, manifest: undefined });
	const ssr = router.serverSsr;
	if (!ssr) throw new Error("Missing native SSR utilities");
	try {
		await router.load();
		await ssr.dehydrate();
		const markup = renderToString(<RouterProvider router={router} />);
		ssr.setRenderFinished();
		return { markup, bootstrap: ssr.takeBufferedHtml() ?? "" };
	} finally {
		ssr.cleanup();
	}
}

if (typeof document !== "undefined") {
	const element = document.getElementById("app");
	if (!element) throw new Error("Missing hydration root");
	window.hydrationTest = {
		get admissions() {
			return admissions;
		},
		errors,
		emitSdk,
		get hydrated() {
			return hydrated;
		},
	};
	if (new URLSearchParams(location.search).get("sdk") === "loading") emitSdk({ status: "loading" });
	const router = createProbeRouter(false);
	void hydrate(router)
		.then(() => {
			hydrateRoot(element, <RouterProvider router={router} />, {
				onRecoverableError: (error) =>
					errors.push(error instanceof Error ? error.message : String(error)),
			});
		})
		.catch((error: unknown) => errors.push(error instanceof Error ? error.message : String(error)));
}

declare global {
	interface Window {
		hydrationTest: {
			admissions: number;
			hydrated: boolean;
			errors: string[];
			emitSdk: typeof emitSdk;
		};
	}
}
