import { ClerkFailed, ClerkLoaded, ClerkLoading, ClerkProvider } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/themes";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";

const isDevAuthBypass = env.VITE_DEV_AUTH_BYPASS;
const AUTH_LOAD_TIMEOUT_MS = 15_000;

export function AuthLoadScreen({ failed = false }: { failed?: boolean }) {
	return (
		<main className="flex min-h-dvh items-center justify-center bg-background px-4">
			<section className="w-full max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
				<img src="/clawdi-logo-transparent.png" alt="Clawdi" className="mx-auto h-10 w-auto" />
				{failed ? (
					<>
						<h1 className="mt-5 text-xl font-semibold tracking-tight">
							Secure sign-in did not load
						</h1>
						<p className="mt-2 text-sm text-muted-foreground">
							Clawdi could not load its sign-in service. No sign-in attempt was submitted. Check
							your connection, then try again.
						</p>
						<div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
							<Button onClick={() => window.location.reload()}>
								<RefreshCw data-icon="inline-start" />
								Try again
							</Button>
							<a href="https://clawdi.ai" className={cn(buttonVariants({ variant: "outline" }))}>
								Go to Clawdi website
								<ExternalLink data-icon="inline-end" />
							</a>
						</div>
					</>
				) : (
					<div role="status" aria-live="polite" className="mt-5">
						<Spinner className="mx-auto size-5" />
						<h1 className="mt-3 text-lg font-semibold">Connecting to secure sign-in</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							This can take longer on a slow connection.
						</p>
					</div>
				)}
			</section>
		</main>
	);
}

function TimedAuthLoading() {
	const [timedOut, setTimedOut] = useState(false);

	useEffect(() => {
		const timeoutId = window.setTimeout(() => setTimedOut(true), AUTH_LOAD_TIMEOUT_MS);
		return () => window.clearTimeout(timeoutId);
	}, []);

	return <AuthLoadScreen failed={timedOut} />;
}

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
			<ClerkLoading>
				<TimedAuthLoading />
			</ClerkLoading>
			<ClerkFailed>
				<AuthLoadScreen failed />
			</ClerkFailed>
			<ClerkLoaded>{children}</ClerkLoaded>
		</ClerkProvider>
	);
}
