import { useRouterState } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

// SDK boundary fixture only. Product routes, auth bridge, and deployment UI are real.
function identity() {
	return typeof document === "undefined"
		? null
		: (document.cookie.match(/(?:^|; )test-user=([^;]+)/)?.[1] ?? null);
}
const getToken = async () => identity();
const AuthContext = createContext<{ userId: string | null; isLoaded: boolean }>({
	userId: null,
	isLoaded: false,
});

export function useAuth() {
	const { userId, isLoaded } = useContext(AuthContext);
	return {
		isLoaded,
		isSignedIn: Boolean(userId),
		userId,
		sessionId: userId ? `session-${userId}` : null,
		getToken,
	};
}
export function useClerk() {
	const { session } = useSession();
	return useMemo(
		() => ({
			status: "ready",
			session,
			signOut: async () => {
				document.cookie = "test-user=; Max-Age=0; Path=/";
				location.assign("/sign-in");
			},
		}),
		[session],
	);
}
export function useSession() {
	const { isLoaded, userId } = useAuth();
	const session = useMemo(
		() =>
			userId
				? {
						id: `session-${userId}`,
						user: { id: userId },
						getToken: async () => userId,
					}
				: null,
		[userId],
	);
	return { isLoaded, session };
}
export function useUser() {
	const auth = useAuth();
	return {
		...auth,
		user: auth.userId
			? {
					id: auth.userId,
					fullName: auth.userId,
					imageUrl: "",
					primaryEmailAddress: { emailAddress: "test@example.test" },
					publicMetadata: {},
				}
			: null,
	};
}
export function ClerkProvider({ children }: { children: ReactNode }) {
	const [auth, setAuth] = useState<{ userId: string | null; isLoaded: boolean }>({
		userId: null,
		isLoaded: false,
	});
	useEffect(() => setAuth({ userId: identity(), isLoaded: true }), []);
	return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
function AuthForm({ signup }: { signup: boolean }) {
	const { isLoaded } = useAuth();
	const search = useRouterState({ select: (state) => state.location.searchStr });
	return (
		<main>
			<h1>{signup ? "Fixture sign up" : "Fixture sign in"}</h1>
			<a href={`${signup ? "/sign-in" : "/sign-up"}${search}`}>
				{signup ? "Sign in instead" : "Sign up instead"}
			</a>
			<button
				type="button"
				disabled={!isLoaded}
				onClick={() => {
					document.cookie = "test-user=account-a; Path=/; SameSite=Lax";
					const target = new URLSearchParams(search).get("redirect_url") ?? "/";
					location.assign(target.startsWith("/") && !target.startsWith("//") ? target : "/");
				}}
			>
				Complete simulated auth return
			</button>
		</main>
	);
}
export function SignIn() {
	return <AuthForm signup={false} />;
}
export function SignUp() {
	return <AuthForm signup />;
}
export function SignInButton({ children }: { children: ReactNode }) {
	return <a href="/sign-in">{children}</a>;
}
export function useSignIn() {
	return { isLoaded: false, signIn: null, setActive: async () => {} };
}
