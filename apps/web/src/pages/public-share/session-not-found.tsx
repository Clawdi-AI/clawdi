import { Link } from "@tanstack/react-router";

/**
 * 404 for share URLs that don't resolve to anything.
 *
 * `notFound()` in `page.tsx` triggers this when the backend returns 404 —
 * the session id (or legacy token) genuinely doesn't exist in the
 * database. Sign-in gates and forbidden cases have dedicated pages
 * (`sign-in-to-view.tsx`, `no-access.tsx`); this is reserved for the
 * "no such session" outcome so the copy can be honest.
 *
 * Server component — reachable to logged-out visitors, shouldn't pull
 * in the client React tree.
 */
export default function ShareNotFound() {
	return (
		<div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
			<div className="text-xs uppercase tracking-wide text-muted-foreground">404</div>
			<h1 className="mt-2 text-2xl font-semibold tracking-tight">Session not found</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				This URL doesn't match any Clawdi session — it may have been deleted, or the link was
				mistyped.
			</p>
			<Link to="/" className="mt-6 text-sm font-medium underline-offset-4 hover:underline">
				Go to Clawdi
			</Link>
		</div>
	);
}
