"use client";

import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import { env } from "@/lib/env";

const DEV_AUTH_BEARER = env.NEXT_PUBLIC_DEV_AUTH_TOKEN;

// Stable identity for the dev-bypass branch: returning a fresh object (and
// fresh `getToken`) each render would churn every `useMemo`/`useQuery` that
// depends on `getToken` (e.g. the channel-edit client), re-creating clients
// and re-issuing in-flight requests. Keep one constant reference.
const DEV_AUTH_TOKEN_RESULT = { getToken: async () => DEV_AUTH_BEARER };

const DEV_USER = {
	id: "dev_browser",
	fullName: env.NEXT_PUBLIC_DEV_AUTH_NAME,
	imageUrl: "",
	primaryEmailAddress: { emailAddress: env.NEXT_PUBLIC_DEV_AUTH_EMAIL },
	publicMetadata: {
		project_owner_handle: "dev-user",
		owner_handle: "dev-user",
	},
};

export function useAuthToken() {
	if (env.NEXT_PUBLIC_DEV_AUTH_BYPASS) {
		return DEV_AUTH_TOKEN_RESULT;
	}
	const { getToken } = useAuth();
	return { getToken };
}

export function useDashboardAuth() {
	if (env.NEXT_PUBLIC_DEV_AUTH_BYPASS) {
		return {
			isSignedIn: true,
			userId: DEV_USER.id,
			getToken: async () => DEV_AUTH_BEARER,
		};
	}
	return useAuth();
}

export function useCurrentUser() {
	if (env.NEXT_PUBLIC_DEV_AUTH_BYPASS) {
		return {
			isLoaded: true,
			isSignedIn: true,
			user: DEV_USER,
		};
	}
	return useUser();
}

export function useAuthActions() {
	if (env.NEXT_PUBLIC_DEV_AUTH_BYPASS) {
		return {
			signOut: async ({ redirectUrl }: { redirectUrl?: string } = {}) => {
				if (typeof window !== "undefined" && redirectUrl) {
					window.location.href = redirectUrl;
				}
			},
		};
	}
	return useClerk();
}
