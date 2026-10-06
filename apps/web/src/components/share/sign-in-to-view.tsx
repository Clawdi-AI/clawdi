"use client";

import { Link, useRouterState } from "@tanstack/react-router";
import { AuthActionLink } from "@/components/auth-action-link";

/**
 * Auth gate page for private session URLs accessed by anonymous visitors.
 *
 * Client component — `AuthActionLink` is interactive Clerk client-side
 * code (it opens a modal in-browser), so the wrapping component needs
 * `"use client"` even though the rest of the page is server-rendered.
 *
 * Shown when the backend returns 401 — i.e. the session exists but no
 * `kind='link'` permission grants public access, AND the visitor isn't
 * signed in. Notion does the same thing: a private page URL hit by a
 * stranger renders a sign-in prompt rather than auto-redirecting away.
 *
 * The auth action forces both sign-in and sign-up returns so post-sign-in
 * the visitor lands back on this same URL — at which point the access
 * check fires again with their JWT and either renders (owner / explicit
 * grant) or shows `<NoAccess />` (signed in but not authorized).
 */
export function SignInToView() {
	const shareUrl = useRouterState({ select: (state) => state.location.href });
	return (
		<div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
			<div className="text-xs uppercase tracking-wide text-muted-foreground">Private session</div>
			<h1 className="mt-2 text-2xl font-semibold tracking-tight">Sign in to view</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				This Clawdi session is private. Sign in to check whether you have access.
			</p>
			<div className="mt-6 flex items-center gap-3 text-sm">
				<AuthActionLink
					href={shareUrl}
					className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90"
				>
					Sign in
				</AuthActionLink>
				<Link to="/" className="font-medium underline-offset-4 hover:underline">
					Go to Clawdi
				</Link>
			</div>
		</div>
	);
}
