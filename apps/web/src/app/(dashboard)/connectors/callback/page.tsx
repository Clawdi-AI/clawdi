"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { IS_HOSTED } from "@/lib/hosted";

/**
 * OAuth callback landing for Composio connect flows initiated from
 * cloud's connectors page in hosted mode. Monorepo's
 * `POST /api/connections/{app}/connect` round-trips the user through
 * the third-party (Gmail / Slack / etc.) and back here via the
 * `redirect_url` we passed when creating the connect link.
 *
 * Composio's success page redirects with no consistent query
 * contract — sometimes `status=success`, sometimes `?connection_id=`,
 * sometimes nothing. We read what we get, invalidate the cached
 * connection list so the detail page refreshes the moment the user
 * navigates back, and bounce them to either the originating app's
 * detail page (if `app=` was preserved by the caller) or the list.
 *
 * Self-host (IS_HOSTED=false) doesn't use this route — cloud-api's
 * connect flow opens OAuth in a new tab and polls in-place.
 */
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

	const status = params.get("status") ?? "success";
	const error = params.get("error");
	const appName = params.get("app");

	const failed = error !== null || status === "error" || status === "failed";

	useEffect(() => {
		// Whether or not the OAuth completed, refresh the connection list
		// so the detail page reflects reality on next view. For hosted,
		// invalidate the hosted query key; cloud-side keys are untouched
		// since OSS users don't reach this route.
		void qc.invalidateQueries({ queryKey: ["hosted", "connections"] });

		// Redirect after a beat so the user sees confirmation before we
		// jump them away. 1.5s is the standard "feedback then go" interval.
		const id = setTimeout(() => {
			const target = appName ? `/connectors/${encodeURIComponent(appName)}` : "/connectors";
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
			<Check className="size-5 text-emerald-600 dark:text-emerald-500" />
			<p className="text-sm font-medium">Connected</p>
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
