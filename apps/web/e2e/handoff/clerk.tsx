import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";

// SDK boundary fixture only. Product routes, auth bridge, and deployment UI are real.
function identity() {
	return typeof document === "undefined"
		? null
		: (document.cookie.match(/(?:^|; )test-user=([^;]+)/)?.[1] ?? null);
}
const getToken = async () => {
	if (document.documentElement.dataset.delayToken === "true") {
		document.documentElement.dataset.tokenWaiting = "true";
		await new Promise<void>((resolve) =>
			window.addEventListener("test-token-release", () => resolve(), { once: true }),
		);
		document.documentElement.dataset.returnedToken = identity() ?? "";
	}
	// Exercise the worst case: an old hook callback returning the new current session's token.
	return identity();
};

export function useAuth() {
	const [userId, setUserId] = useState<string | null>(null);
	const [isLoaded, setLoaded] = useState(false);
	useLayoutEffect(() => {
		document.documentElement.dataset.committedUser = userId ?? "";
	}, [userId]);
	useEffect(() => {
		const update = () => setUserId(identity());
		update();
		setLoaded(true);
		window.addEventListener("test-session-change", update);
		return () => window.removeEventListener("test-session-change", update);
	}, []);
	return {
		isLoaded,
		isSignedIn: Boolean(userId),
		userId,
		sessionId: userId ? `session-${userId}` : null,
		getToken,
	};
}
export function useClerk() {
	return {
		status: "ready",
		signOut: async () => {
			document.cookie = "test-user=; Max-Age=0; Path=/";
			location.assign("/sign-in");
		},
	};
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
	return children;
}
function AuthForm({ signup }: { signup: boolean }) {
	const search = useRouterState({ select: (state) => state.location.searchStr });
	return (
		<main>
			<h1>{signup ? "Fixture sign up" : "Fixture sign in"}</h1>
			<a href={`${signup ? "/sign-in" : "/sign-up"}${search}`}>
				{signup ? "Sign in instead" : "Sign up instead"}
			</a>
			<button
				type="button"
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
