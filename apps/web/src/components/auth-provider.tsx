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
			signInFallbackRedirectUrl="/"
			signInUrl="/sign-in"
			signUpFallbackRedirectUrl="/"
			signUpUrl="/sign-up"
		>
			{children}
		</ClerkProvider>
	);
}
