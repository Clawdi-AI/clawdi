import { useQueryClient } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { hydrate } from "@tanstack/react-router/ssr/client";
import { useEffect, useLayoutEffect, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { AuthRouterBridge } from "@/components/auth-router-bridge";
import { ProtectedAuthBoundary, ProtectedRouteError } from "@/components/protected-auth-boundary";
import { useRouteAuth } from "@/lib/auth-client";
import { type AppRouterContext, type RouteAuth, requireRouteIdentity } from "@/lib/route-auth";
import { useHydrated } from "@/lib/use-hydrated";
import { emitSdk } from "./clerk-fixture";

const serverAuth: RouteAuth = { status: "signed-in", userId: "user-a", sessionId: "session-a" };
const observations: { status: RouteAuth["status"]; sameClient: boolean; cached: boolean }[] = [];
const errors: string[] = [];
let mounts = 0;
let unmounts = 0;
let hydrated = false;
let originalClient: ReturnType<typeof useQueryClient> | undefined;

function CacheProbe() {
	const client = useQueryClient();
	const auth = useRouteAuth();
	const isHydrated = useHydrated();
	const [firstClient] = useState(() => {
		client.setQueryData(["hydration-probe"], "fixture-cache");
		originalClient = client;
		return client;
	});
	useLayoutEffect(() => {
		hydrated = isHydrated;
		observations.push({
			status: auth.status,
			sameClient: client === firstClient,
			cached: client.getQueryData(["hydration-probe"]) === "fixture-cache",
		});
	});
	return <Outlet />;
}

function DocumentProbe() {
	useEffect(() => {
		mounts += 1;
		return () => {
			unmounts += 1;
		};
	}, []);
	return (
		<main data-hydration-private>
			<h1>Server-admitted document</h1>
			<iframe
				title="SSR runtime"
				srcDoc="<!doctype html><textarea aria-label='Runtime draft'></textarea>"
			/>
		</main>
	);
}

function createProbeRouter(isServer: boolean) {
	const root = createRootRouteWithContext<AppRouterContext>()({
		component: () => (
			<AuthRouterBridge>
				<CacheProbe />
			</AuthRouterBridge>
		),
	});
	const protectedRoute = createRoute({
		getParentRoute: () => root,
		id: "_protected",
		beforeLoad: ({ context, location }) => ({
			authIdentity: requireRouteIdentity(context.auth, location.href),
		}),
		errorComponent: ProtectedRouteError,
		component: () => (
			<ProtectedAuthBoundary identity={protectedRoute.useRouteContext().authIdentity}>
				<Outlet />
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
		context: { auth: isServer ? serverAuth : undefined },
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
		observations,
		errors,
		emitSdk,
		get hydrated() {
			return hydrated;
		},
		get originalCached() {
			return originalClient?.getQueryData(["hydration-probe"]) === "fixture-cache";
		},
		get mounts() {
			return mounts;
		},
		get unmounts() {
			return unmounts;
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
			hydrated: boolean;
			originalCached: boolean;
			observations: typeof observations;
			errors: string[];
			mounts: number;
			unmounts: number;
			emitSdk: typeof emitSdk;
		};
	}
}
