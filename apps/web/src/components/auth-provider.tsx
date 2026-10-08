import { ClerkProvider } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/themes";
import { useRouter } from "@tanstack/react-router";
import { env } from "@/lib/env";

const isDevAuthBypass = env.VITE_DEV_AUTH_BYPASS;
export function AuthProvider({ children }: { children: React.ReactNode }) {
	const nonce = useRouter().options.ssr?.nonce;
	if (isDevAuthBypass) return <>{children}</>;

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
