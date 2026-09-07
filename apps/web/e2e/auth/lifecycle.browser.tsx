import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Link,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountSuspensionBoundary } from "@/components/account-suspension-boundary";
import { AuthRouterBridge } from "@/components/auth-router-bridge";
import { AuthStatus } from "@/components/auth-status";
import { ProtectedAuthBoundary } from "@/components/protected-auth-boundary";
import { UnsavedNavigationGuard } from "@/components/unsaved-navigation-guard";
import { ApiError, normalizeApiError } from "@/lib/api-errors";
import { useAuthToken, useRouteAuth } from "@/lib/auth-client";
import {
	type AppRouterContext,
	RouteAuthUnavailable,
	requireRouteIdentity,
} from "@/lib/route-auth";
import { emitSdk, signOutCalls } from "./clerk-fixture";
import "@/styles/globals.css";

const commits: { identity: string | null; data: string | undefined }[] = [];
let currentClient: ReturnType<typeof useQueryClient> | undefined;
let held: ReturnType<typeof Promise.withResolvers<string>> | undefined;
let abortedPreload = false;

const root = createRootRouteWithContext<AppRouterContext>()({
	component: () => (
		<AuthRouterBridge>
			<Outlet />
		</AuthRouterBridge>
	),
});
const protectedRoute = createRoute({
	getParentRoute: () => root,
	id: "_protected",
	beforeLoad: ({ context, location }) => ({
		authIdentity: requireRouteIdentity(context.auth, location.href),
	}),
	errorComponent: ({ error }) =>
		error instanceof RouteAuthUnavailable ? (
			<AuthStatus status={error.status} />
		) : (
			<p role="alert">Route failed</p>
		),
	component: () => {
		const { authIdentity } = protectedRoute.useRouteContext();
		return (
			<ProtectedAuthBoundary identity={authIdentity}>
				<AccountSuspensionBoundary>
					<PrivatePane />
				</AccountSuspensionBoundary>
			</ProtectedAuthBoundary>
		);
	},
});
const a = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/private/a",
	component: () => <h1>Destination A</h1>,
});
const b = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/private/b",
	loader: async ({ abortController }) => {
		const pending = held;
		if (!pending) return "ready";
		const onAbort = () => {
			abortedPreload = true;
			pending.reject(abortController.signal.reason);
		};
		abortController.signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await pending.promise;
		} finally {
			abortController.signal.removeEventListener("abort", onAbort);
		}
	},
	component: () => <h1>Destination B</h1>,
});
const signIn = createRoute({
	getParentRoute: () => root,
	path: "/sign-in",
	component: () => <h1>Sign in</h1>,
});
const publicRoute = createRoute({
	getParentRoute: () => root,
	path: "/public",
	component: () => <h1>Public content</h1>,
});
const router = createRouter({
	routeTree: root.addChildren([protectedRoute.addChildren([a, b]), signIn, publicRoute]),
	context: { auth: undefined },
	defaultPreload: "intent",
});

function PrivatePane() {
	const auth = useRouteAuth();
	const { getToken } = useAuthToken();
	const client = useQueryClient();
	const [draft, setDraft] = useState("");
	const data = useQuery({
		queryKey: ["private-destination"],
		retry: false,
		queryFn: async ({ signal }) => {
			const token = await getToken();
			const response = await fetch("http://127.0.0.1:8000/private-data", {
				headers: { authorization: `Bearer ${token}` },
				signal,
			});
			if (!response.ok) throw new ApiError(response.status, "Denied");
			return response.text();
		},
	});
	useLayoutEffect(() => {
		currentClient = client;
		commits.push({
			identity: auth.status === "signed-in" ? `${auth.userId}:${auth.sessionId}` : null,
			data: data.data,
		});
	});
	return (
		<main>
			<nav>
				<Link<typeof router> to="/private/a">A</Link>
				<Link<typeof router> to="/private/b">B</Link>
				<Link<typeof router> to="/public">Public</Link>
			</nav>
			<Outlet />
			{data.error ? (
				<p role="alert">{normalizeApiError(data.error)}</p>
			) : (
				<p data-private>{data.data}</p>
			)}
			<textarea aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
			<iframe
				title="Private runtime"
				srcDoc="<!doctype html><textarea aria-label='Runtime draft'></textarea>"
			/>
			<UnsavedNavigationGuard dirty={Boolean(draft)} busy={false} />
		</main>
	);
}

window.authTest = {
	emitSdk,
	commits,
	navigate: (to) => router.navigate({ to }),
	holdPreload: () => {
		router.clearCache({ filter: (match) => match.routeId === b.id });
		held = Promise.withResolvers<string>();
		void router.preloadRoute({ to: "/private/b" }).catch(() => undefined);
	},
	releasePreload: () => {
		held?.resolve("old-generation");
		held = undefined;
	},
	get abortedPreload() {
		return abortedPreload;
	},
	get signOutCalls() {
		return signOutCalls;
	},
	refetch: () => currentClient?.refetchQueries(),
};
declare global {
	interface Window {
		authTest: {
			emitSdk: typeof emitSdk;
			commits: typeof commits;
			navigate: (to: string) => Promise<void>;
			holdPreload: () => void;
			releasePreload: () => void;
			abortedPreload: boolean;
			signOutCalls: number;
			refetch: () => Promise<void> | undefined;
		};
	}
}
const element = document.getElementById("app");
if (!element) throw new Error("Missing test root");
createRoot(element).render(<RouterProvider router={router} />);
