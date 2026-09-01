"use client";

import { useAuth, useClerk, useSession, useUser } from "@clerk/tanstack-react-start";
import { useCallback } from "react";
import { ApiError } from "@/lib/api-errors";
import { env } from "@/lib/env";
import { resolveRouteAuth } from "@/lib/route-auth";

const DEV_AUTH_BEARER = env.VITE_DEV_AUTH_TOKEN;

// Stable identity for the dev-bypass branch: returning a fresh object (and
// fresh `getToken`) each render would churn every `useMemo`/`useQuery` that
// depends on `getToken` (e.g. the channel-edit client), re-creating clients
// and re-issuing in-flight requests. Keep one constant reference.
const DEV_AUTH_TOKEN_RESULT = { getToken: async () => DEV_AUTH_BEARER };

const DEV_USER = {
	id: "dev_browser",
	fullName: env.VITE_DEV_AUTH_NAME,
	imageUrl: "",
	primaryEmailAddress: { emailAddress: env.VITE_DEV_AUTH_EMAIL },
	publicMetadata: {
		project_owner_handle: "dev-user",
		owner_handle: "dev-user",
	},
};

export function useAuthToken() {
	if (env.VITE_DEV_AUTH_BYPASS) {
		return DEV_AUTH_TOKEN_RESULT;
	}
	const { session } = useSession();
	const clerk = useClerk();
	const getToken = useCallback(async () => {
		// A retained request must never acquire credentials for a later session.
		if (!session || clerk.session?.id !== session.id) {
			throw new ApiError(401, "Session is not available");
		}
		const token = await session.getToken();
		if (!token || clerk.session?.id !== session.id) {
			throw new ApiError(401, "Session is not available");
		}
		return token;
	}, [clerk, session]);
	return { getToken };
}

export function useDashboardAuth() {
	if (env.VITE_DEV_AUTH_BYPASS) {
		return {
			isLoaded: true,
			isSignedIn: true,
			userId: DEV_USER.id,
			sessionId: "dev_browser_session",
			getToken: async () => DEV_AUTH_BEARER,
		};
	}
	const auth = useAuth();
	const { getToken } = useAuthToken();
	return { ...auth, getToken };
}

export function useRouteAuth() {
	if (env.VITE_DEV_AUTH_BYPASS) {
		return { status: "signed-in", userId: DEV_USER.id, sessionId: "dev_browser_session" } as const;
	}
	const auth = useAuth();
	const clerk = useClerk();
	// ClerkProvider propagates status changes. useAuth owns the native SSR
	// snapshot during SDK bootstrap; script loading is not identity loss.
	return resolveRouteAuth(auth, clerk.status);
}

export function useCurrentUser() {
	if (env.VITE_DEV_AUTH_BYPASS) {
		return {
			isLoaded: true,
			isSignedIn: true,
			user: DEV_USER,
		};
	}
	return useUser();
}

export function useAuthActions() {
	if (env.VITE_DEV_AUTH_BYPASS) {
		return {
			signOut: async ({ redirectUrl }: { redirectUrl?: string } = {}) => {
				if (typeof window !== "undefined" && redirectUrl) {
					window.location.href = redirectUrl;
				}
			},
		};
	}
	const clerk = useClerk();
	const desktopBridge = typeof window === "undefined" ? undefined : window.clawdiDesktop;
	if (desktopBridge) {
		return {
			signOut: async () => {
				await desktopBridge.signOut();
			},
		};
	}
	return {
		...clerk,
		signOut: async ({ redirectUrl }: { redirectUrl?: string } = {}) => {
			await clerk.signOut({ redirectUrl });
		},
	};
}

// Unlike useAuth's SSR snapshot, a SessionResource is usable only after the
// browser SDK has supplied it. Private data regions wait for that native resource.
export function useSessionIdentity() {
	if (env.VITE_DEV_AUTH_BYPASS) return JSON.stringify([DEV_USER.id, "dev_browser_session"]);
	const { isLoaded, session } = useSession();
	return isLoaded && session ? JSON.stringify([session.user.id, session.id]) : null;
}
