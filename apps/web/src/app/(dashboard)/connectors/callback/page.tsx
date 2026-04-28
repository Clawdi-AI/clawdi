"use client";

import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { IS_HOSTED } from "@/lib/hosted";

/**
 * OAuth callback landing for Composio connect flows initiated from
 * cloud's connectors page in hosted mode. Monorepo's
 * `POST /connections/{app}/connect` round-trips the user through the
 * third-party (Gmail / Slack / etc.) and back here via the
 * `redirect_url` we passed when creating the connect link.
 *
 * Composio's success page redirects with no consistent query
 * contract — sometimes `status=success`, sometimes `?connection_id=`,
 * sometimes nothing at all. We deliberately do NOT display a
 * "Connected" confirmation here: the only signal of truth is the
 * verify endpoint (or the connection list refetch after invalidation).
 * Instead we show neutral "Authorization complete — returning…" and
 * let the detail page render the actual connection status. Errors
 * still get the destructive treatment because OAuth failures usually
 * do come back with `?error=` populated.
 *
 * Self-host (IS_HOSTED=false) doesn't use this route — cloud-api's
 * connect flow opens OAuth in a new tab and polls in-place.
 */

// Slug allowlist matches monorepo's `_SLUG_RE` for connector app names
// (lowercase letters, digits, underscore, dash). Keeps a crafted
// `?app=https://evil.com` from sneaking past `encodeURIComponent` and
// landing the user somewhere useful for an attacker.
const APP_SLUG_RE = /^[a-z0-9_-]{1,200}$/;

export default function ConnectorCallbackPage() {
	return (
		<Suspense
			fallback={
				<CallbackShell>
					<Spinner className="size-5 text-muted-foreground" />
					<p className="text-sm text-muted-foreground">Loading…</p>
				</CallbackShell>
			}
		>
			<CallbackInner />
		</Suspense>
	);
}

function CallbackInner() {
	const params = useSearchParams();
	const router = useRouter();
	const qc = useQueryClient();

	const status = params.get("status");
	const error = params.get("error");
	const rawApp = params.get("app");
	const appName = rawApp && APP_SLUG_RE.test(rawApp) ? rawApp : null;

	const failed = error !== null || status === "error" || status === "failed";

	useEffect(() => {
		// Whether or not the OAuth completed, refresh the connection list
		// so the detail page reflects reality on next view. For hosted,
		// invalidate the hosted query key; cloud-side keys are untouched
		// since OSS users don't reach this route.
		void qc.invalidateQueries({ queryKey: ["hosted", "connections"] });

		// Redirect after a beat so the user sees the spinner before we
		// jump them away. 1.5s is the standard "feedback then go"
		// interval. Slug already validated at parse time — no path
		// injection possible.
		const id = setTimeout(() => {
			const target = appName ? `/connectors/${appName}` : "/connectors";
			router.replace(target);
		}, 1500);
		return () => clearTimeout(id);
	}, [appName, qc, router]);

	if (!IS_HOSTED) {
		// Defensive: the callback URL was emitted from hosted code, but if
		// an OSS instance somehow lands here we shouldn't pretend success.
		return (
			<CallbackShell>
				<X className="size-5 text-muted-foreground" />
				<p className="text-sm text-muted-foreground">This page only applies to hosted Clawdi.</p>
			</CallbackShell>
		);
	}

	if (failed) {
		return (
			<CallbackShell>
				<X className="size-5 text-destructive" />
				<p className="text-sm font-medium">Connection failed</p>
				<p className="text-xs text-muted-foreground">
					{error || "OAuth did not complete. Try again from the connector page."}
				</p>
			</CallbackShell>
		);
	}

	return (
		<CallbackShell>
			<Spinner className="size-5 text-muted-foreground" />
			<p className="text-sm font-medium">Authorization complete</p>
			<p className="text-xs text-muted-foreground">Returning to connectors…</p>
		</CallbackShell>
	);
}

function CallbackShell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-[60vh] items-center justify-center px-4 lg:px-6">
			<Card className="w-full max-w-sm">
				<CardContent className="flex flex-col items-center gap-2 p-8 text-center">
					{children}
				</CardContent>
			</Card>
		</div>
	);
}
