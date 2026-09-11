import { ClerkProvider } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/themes";
import { env } from "@/lib/env";

export function DesktopAuthProvider({ children }: { children: React.ReactNode }) {
	return (
		<ClerkProvider
			appearance={shadcn}
			prefetchUI={false}
			publishableKey={env.VITE_CLERK_PUBLISHABLE_KEY}
			signInFallbackRedirectUrl="/"
			signUpFallbackRedirectUrl="/"
		>
			{children}
		</ClerkProvider>
	);
}
