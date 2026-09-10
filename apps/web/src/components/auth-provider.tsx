import { ClerkProvider } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/themes";
import { env } from "@/lib/env";

const isDevAuthBypass = env.VITE_DEV_AUTH_BYPASS;

export function AuthProvider({ children }: { children: React.ReactNode }) {
	if (isDevAuthBypass) return <>{children}</>;

	return (
		<ClerkProvider
			appearance={shadcn}
			publishableKey={env.VITE_CLERK_PUBLISHABLE_KEY}
			// Clerk clears its session while awaiting post-login navigation. Enter
			// through SSR so that transient state cannot replace the dashboard.
			routerPush={(to) => window.location.assign(to)}
			routerReplace={(to) => window.location.replace(to)}
			signInFallbackRedirectUrl="/"
			signInUrl="/sign-in"
			signUpFallbackRedirectUrl="/"
			signUpUrl="/sign-up"
		>
			{children}
		</ClerkProvider>
	);
}
