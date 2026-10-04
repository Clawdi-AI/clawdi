import { useRouterState } from "@tanstack/react-router";
import { LoaderCircle, LogIn, RotateCcw } from "lucide-react";
import { AuthActionLink } from "@/components/auth-action-link";
import { Button } from "@/components/ui/button";

export function AuthStatus({
	status,
	onSignIn,
	signingIn = false,
	error,
}: {
	status: "loading" | "unavailable" | "signed-out";
	onSignIn?: () => void;
	signingIn?: boolean;
	error?: string | null;
}) {
	const href = useRouterState({ select: (state) => state.location.href });
	return (
		<section className="flex min-h-64 flex-col items-center justify-center gap-4 p-6">
			{status === "loading" ? (
				<LoaderCircle className="size-5 animate-spin" role="status" aria-label="Loading session" />
			) : (
				<p className="text-sm text-muted-foreground">
					{status === "signed-out" ? "Please sign in to continue." : "Session unavailable."}
				</p>
			)}
			{onSignIn ? (
				<Button onClick={onSignIn} disabled={signingIn}>
					<LogIn className="size-4" />
					Sign in again
				</Button>
			) : status === "signed-out" ? (
				<Button nativeButton={false} render={<AuthActionLink href={href} />}>
					<LogIn className="size-4" />
					Sign in
				</Button>
			) : (
				<Button variant="outline" onClick={() => window.location.reload()}>
					<RotateCcw className="size-4" />
					Reload
				</Button>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</section>
	);
}
