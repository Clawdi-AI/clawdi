import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/themes";

const isDevAuthBypass =
	process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "true" && process.env.NODE_ENV !== "production";

export function AuthProvider({ children }: { children: React.ReactNode }) {
	if (isDevAuthBypass) return <>{children}</>;

	return <ClerkProvider appearance={{ baseTheme: shadcn }}>{children}</ClerkProvider>;
}
