import type {
	ClerkProvider as NativeClerkProvider,
	useClerk as nativeUseClerk,
} from "@clerk/tanstack-react-start";
import { useRouterState } from "@tanstack/react-router";
import type { ComponentProps } from "react";
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
type ModalOptions = Parameters<ReturnType<typeof nativeUseClerk>["openSignIn"]>[0];
const ModalContext = createContext<(options: ModalOptions) => void>(() => {});

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
	const openSignIn = useContext(ModalContext);
	return useMemo(
		() => ({
			status: "ready",
			openSignIn,
			session,
			signOut: async () => {
				// biome-ignore lint/suspicious/noDocumentCookie: Host-bound SDK fixture on HTTP where Cookie Store is unavailable.
				document.cookie = "test-user=; Max-Age=0; Path=/";
				location.assign("/sign-in");
			},
		}),
		[session, openSignIn],
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
export function ClerkProvider({
	children,
	...defaults
}: ComponentProps<typeof NativeClerkProvider>) {
	const [auth, setAuth] = useState<{ userId: string | null; isLoaded: boolean }>({
		userId: null,
		isLoaded: false,
	});
	const [modal, setModal] = useState<ModalOptions | null>(null);
	useEffect(() => setAuth({ userId: identity(), isLoaded: true }), []);
	useEffect(() => {
		if (auth.isLoaded) document.documentElement.dataset.clerkFixtureLoaded = "true";
	}, [auth.isLoaded]);
	return (
		<AuthContext.Provider value={auth}>
			<ModalContext.Provider value={setModal}>
				{children}
				{modal && (
					<div role="dialog" aria-modal="true" aria-label="Clerk fixture sign in">
						<button type="button" onClick={() => setModal(null)}>
							Dismiss auth modal
						</button>
						{([false, true] as const).map((signup) => (
							<button
								key={String(signup)}
								type="button"
								onClick={() => {
									// biome-ignore lint/suspicious/noDocumentCookie: Host-bound SDK fixture on HTTP where Cookie Store is unavailable.
									document.cookie = "test-user=account-a; Path=/; SameSite=Lax";
									const target = signup
										? (modal.signUpForceRedirectUrl ??
											defaults.signUpForceRedirectUrl ??
											defaults.signUpFallbackRedirectUrl ??
											"/")
										: (modal.forceRedirectUrl ??
											defaults.signInForceRedirectUrl ??
											defaults.signInFallbackRedirectUrl ??
											"/");
									setAuth({ userId: "account-a", isLoaded: true });
									setModal(null);
									location.assign(target);
								}}
							>
								Complete modal {signup ? "sign up" : "sign in"}
							</button>
						))}
					</div>
				)}
			</ModalContext.Provider>
		</AuthContext.Provider>
	);
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
					// biome-ignore lint/suspicious/noDocumentCookie: Host-bound SDK fixture on HTTP where Cookie Store is unavailable.
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
