import { ClerkProvider } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/themes";
import { useRouter } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { env } from "@/lib/env";

const isDevAuthBypass = env.VITE_DEV_AUTH_BYPASS;
const DesktopAuthProvider =
	import.meta.env.VITE_CLAWDI_DESKTOP_BUILD === "true"
		? lazy(() =>
				import("@/components/desktop-auth-provider").then((module) => ({
					default: module.DesktopAuthProvider,
				})),
			)
		: null;

export function AuthProvider({ children }: { children: React.ReactNode }) {
	const nonce = useRouter().options.ssr?.nonce;
	if (isDevAuthBypass) return <>{children}</>;
	if (DesktopAuthProvider) {
		return (
			<Suspense fallback={null}>
				<DesktopAuthProvider>{children}</DesktopAuthProvider>
			</Suspense>
		);
	}

	return (
		<ClerkProvider
			nonce={nonce}
			appearance={shadcn}
			publishableKey={env.VITE_CLERK_PUBLISHABLE_KEY}
			signInFallbackRedirectUrl="/"
			signInUrl="/sign-in"
			signUpFallbackRedirectUrl="/"
			signUpUrl="/sign-up"
		>
			{children}
		</ClerkProvider>
	);
}
