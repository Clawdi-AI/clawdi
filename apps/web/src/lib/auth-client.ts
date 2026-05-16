"use client";

import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import { env } from "@/lib/env";

export const DEV_AUTH_BEARER = env.NEXT_PUBLIC_DEV_AUTH_TOKEN;

const DEV_USER = {
	id: "dev_browser",
	fullName: "Dev User",
	imageUrl: "",
	primaryEmailAddress: { emailAddress: "dev@clawdi.local" },
	publicMetadata: {
		project_owner_handle: "dev-user",
		owner_handle: "dev-user",
	},
};

export function useAuthToken() {
	if (env.NEXT_PUBLIC_DEV_AUTH_BYPASS) {
		return { getToken: async () => DEV_AUTH_BEARER };
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
