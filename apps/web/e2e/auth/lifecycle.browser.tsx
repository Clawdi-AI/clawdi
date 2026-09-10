import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "@/components/auth-provider";
import { AuthStatus } from "@/components/auth-status";
import { ProtectedAuthBoundary } from "@/components/protected-auth-boundary";
import { Providers } from "@/components/providers";
import { UnsavedNavigationGuard } from "@/components/unsaved-navigation-guard";
import { useApi } from "@/lib/api";
import { ApiError, normalizeApiError } from "@/lib/api-errors";
import { useAuthToken, useRouteAuth } from "@/lib/auth-client";
import { RouteAuthUnavailable, requireRouteIdentity } from "@/lib/route-auth";
import DashboardLayout from "@/pages/dashboard/layout";
import SharePage from "@/pages/share/project-share-page";
import {
	activateSession,
	emitSdk,
	releaseActivation,
	serverAuth,
	signOutCalls,
} from "./clerk-fixture";
import "@/styles/globals.css";

const commits: { identity: string | null; data: string | undefined }[] = [];
let currentClient: ReturnType<typeof useQueryClient> | undefined;
let held: ReturnType<typeof Promise.withResolvers<string>> | undefined;
let abortedPreload = false;
let savedGetToken: (() => Promise<string>) | undefined;
let currentGetToken: (() => Promise<string>) | undefined;
let mutate: (() => Promise<unknown>) | undefined;

const root = createRootRoute({
	component: () => (
		<AuthProvider>
			<Providers>
				<Outlet />
			</Providers>
		</AuthProvider>
	),
});
const protectedRoute = createRoute({
	getParentRoute: () => root,
	id: "_protected",
	beforeLoad: async ({ location }) => {
		const { userId, sessionId } = serverAuth();
		return {
			authIdentity: requireRouteIdentity(
				userId && sessionId ? { status: "signed-in", userId, sessionId } : { status: "signed-out" },
				location.href,
			),
		};
	},
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
				<Outlet />
			</ProtectedAuthBoundary>
		);
	},
});
const dashboard = createRoute({
	getParentRoute: () => protectedRoute,
	id: "_dashboard",
	component: () => (
		<DashboardLayout>
			<PrivatePane />
		</DashboardLayout>
	),
});
const a = createRoute({
	getParentRoute: () => dashboard,
	path: "/private/a",
	component: () => <h1>Destination A</h1>,
});
const b = createRoute({
	getParentRoute: () => dashboard,
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
const share = createRoute({
	getParentRoute: () => root,
	path: "/share/fixture",
	component: () => <SharePage token="fixture" />,
});
const router = createRouter({
	routeTree: root.addChildren([
		protectedRoute.addChildren([dashboard.addChildren([a, b])]),
		signIn,
		publicRoute,
		share,
	]),
	defaultPreload: "intent",
});

function PrivatePane() {
	const auth = useRouteAuth();
	const { getToken } = useAuthToken();
	const client = useQueryClient();
	const api = useApi();
	const mutation = useMutation({
		mutationFn: () =>
			api.POST("/v1/me/invitations/{invitation_id}/decline", {
				params: { path: { invitation_id: "fixture" } },
			}),
		onSuccess: () => client.setQueryData(["old-mutation"], "old-account-result"),
	});
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
		currentGetToken = getToken;
		mutate = mutation.mutateAsync;
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
	activateSession,
	releaseActivation,
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
	saveCredentials: () => {
		savedGetToken = currentGetToken;
	},
	useSavedCredentials: async () => {
		try {
			return await savedGetToken?.();
		} catch {
			return "retired";
		}
	},
	mutate: () => mutate?.(),
	get oldMutationPublished() {
		return currentClient?.getQueryData(["old-mutation"]) !== undefined;
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
			activateSession: typeof activateSession;
			releaseActivation: typeof releaseActivation;
			commits: typeof commits;
			navigate: (to: string) => Promise<void>;
			holdPreload: () => void;
			releasePreload: () => void;
			saveCredentials: () => void;
			useSavedCredentials: () => Promise<string | undefined>;
			mutate: () => Promise<unknown> | undefined;
			oldMutationPublished: boolean;
			abortedPreload: boolean;
			signOutCalls: number;
			refetch: () => Promise<void> | undefined;
		};
	}
}
const element = document.getElementById("app");
if (!element) throw new Error("Missing test root");
createRoot(element).render(<RouterProvider router={router} />);
