import { LogOut, Mail, ShieldOff } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function AccountSuspendedPage({
	onSignOut,
	signingOut = false,
	signOutError = null,
}: {
	onSignOut: () => void;
	signingOut?: boolean;
	signOutError?: string | null;
}) {
	return (
		<main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12">
			<section className="w-full max-w-lg text-center" aria-labelledby="account-suspended-title">
				<img
					src="/clawdi-logo-transparent.png"
					alt="Clawdi"
					className="mx-auto size-12 rounded-md"
				/>
				<div className="mx-auto mt-8 flex size-11 items-center justify-center rounded-md border bg-muted text-muted-foreground">
					<ShieldOff className="size-5" aria-hidden="true" />
				</div>
				<h1 id="account-suspended-title" className="mt-5 text-xl font-semibold">
					Account deactivated
				</h1>
				<p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
					Your account has been deactivated and can no longer access Clawdi.
				</p>
				<p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
					Contact support if you believe this is a mistake or need help.
				</p>
				<div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
					<a href="mailto:support@clawdi.ai" className={cn(buttonVariants())}>
						<Mail data-icon="inline-start" />
						Contact support
					</a>
					<Button variant="outline" disabled={signingOut} onClick={onSignOut}>
						{signingOut ? (
							<Spinner data-icon="inline-start" aria-label="Signing out" />
						) : (
							<LogOut data-icon="inline-start" />
						)}
						{signingOut ? "Signing out" : "Sign out"}
					</Button>
				</div>
				{signOutError ? (
					<p className="mt-4 text-sm text-destructive" role="alert">
						{signOutError}
					</p>
				) : null}
			</section>
		</main>
	);
}
