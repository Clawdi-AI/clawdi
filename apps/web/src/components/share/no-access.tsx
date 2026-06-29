import Link from "@/lib/router-link";

/**
 * Forbidden page for share URLs the visitor isn't allowed to view.
 *
 * Shown when the backend returns 403 — i.e. the visitor IS signed in,
 * but no permission row grants them access AND they're not the owner.
 * Distinct from `<SignInToView />` (which handles 401, not authed) and
 * `not-found.tsx` (which handles 404, session genuinely missing).
 */
export function NoAccess() {
	return (
		<div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
			<div className="text-xs uppercase tracking-wide text-muted-foreground">No access</div>
			<h1 className="mt-2 text-2xl font-semibold tracking-tight">
				You don't have access to this session
			</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				The owner hasn't granted your account permission to view this Clawdi session. Ask them to
				share the link with you, or to invite you directly.
			</p>
			<Link href="/" className="mt-6 text-sm font-medium underline-offset-4 hover:underline">
				Go to Clawdi
			</Link>
		</div>
	);
}
