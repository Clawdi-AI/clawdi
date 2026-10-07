import { useAuth, useUser } from "@clerk/expo";
import { useMemo } from "react";

export function isDevAuthBypass() {
	return __DEV__ && process.env.EXPO_PUBLIC_DEV_AUTH_BYPASS === "1";
}

type AppAuth = Readonly<{
	isLoaded: boolean;
	isSignedIn: boolean;
	userId: string | null;
	sessionId: string | null;
	getToken: ReturnType<typeof useAuth>["getToken"];
}>;

type ClerkUser = NonNullable<ReturnType<typeof useUser>["user"]>;
type CurrentUser = Readonly<{
	isLoaded: boolean;
	user:
		| (Pick<ClerkUser, "id" | "fullName" | "firstName" | "imageUrl"> & {
				primaryEmailAddress: Pick<
					NonNullable<ClerkUser["primaryEmailAddress"]>,
					"emailAddress"
				> | null;
		  })
		| null;
}>;

// Keep the entire fixture behind an inline development check so Metro removes
// the identity and bearer from production bundles, even when the env flag is set.
// Stable objects/functions prevent API clients and queries from churning.
const devAuth =
	__DEV__ && process.env.EXPO_PUBLIC_DEV_AUTH_BYPASS === "1"
		? {
				auth: {
					isLoaded: true,
					isSignedIn: true,
					userId: "dev_browser",
					sessionId: "dev_browser_session",
					getToken: async () => process.env.EXPO_PUBLIC_DEV_AUTH_TOKEN ?? "dev-bypass",
				},
				currentUser: {
					isLoaded: true,
					user: {
						id: "dev_browser",
						fullName: process.env.EXPO_PUBLIC_DEV_AUTH_NAME ?? "Avery Chen",
						firstName: (process.env.EXPO_PUBLIC_DEV_AUTH_NAME ?? "Avery Chen").split(" ")[0],
						imageUrl: "",
						primaryEmailAddress: {
							emailAddress: process.env.EXPO_PUBLIC_DEV_AUTH_EMAIL ?? "avery@clawdi.dev",
						},
					},
				},
			}
		: null;

export function useAppAuth(): AppAuth {
	if (__DEV__ && process.env.EXPO_PUBLIC_DEV_AUTH_BYPASS === "1" && devAuth) return devAuth.auth;
	const { isLoaded, isSignedIn, userId, sessionId, getToken } = useAuth();
	return useMemo(
		() => ({
			isLoaded,
			isSignedIn: Boolean(isSignedIn),
			userId: userId ?? null,
			sessionId: sessionId ?? null,
			getToken,
		}),
		[isLoaded, isSignedIn, userId, sessionId, getToken],
	);
}

export function useCurrentUser(): CurrentUser {
	if (__DEV__ && process.env.EXPO_PUBLIC_DEV_AUTH_BYPASS === "1" && devAuth)
		return devAuth.currentUser;
	const { isLoaded, user } = useUser();
	return useMemo(() => ({ isLoaded, user: user ?? null }), [isLoaded, user]);
}

const devSignOut = async () => undefined;

/** Clerk sign-out; the signed-in layouts then route to sign-in. The dev identity cannot sign out. */
export function useAppSignOut(): () => Promise<unknown> {
	if (__DEV__ && process.env.EXPO_PUBLIC_DEV_AUTH_BYPASS === "1" && devAuth) return devSignOut;
	return useAuth().signOut;
}
