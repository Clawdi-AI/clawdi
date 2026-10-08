"use client";

import * as Sentry from "@sentry/tanstackstart-react";
import { useRouter } from "@tanstack/react-router";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { isApiNetworkError } from "@/lib/api-errors";

const isDevelopment =
	(import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.MODE !==
	"production";

/**
 * Root error boundary for the whole app.
 *
 * The router catches any unhandled render/data error and mounts this component.
 * Keeping it minimal: user sees a clear message + a retry button + a dev-only
 * error detail, nothing more.
 */
export default function RootError({ error, reset }: { error: unknown; reset: () => void }) {
	const router = useRouter();
	const message = error instanceof Error ? error.message : String(error);
	const digest =
		typeof error === "object" && error !== null && "digest" in error
			? typeof error.digest === "string"
				? error.digest
				: undefined
			: undefined;

	useEffect(() => {
		// Lost connections are client conditions, not app faults.
		if (import.meta.env.VITE_SENTRY_DSN && !isApiNetworkError(error)) {
			Sentry.captureException(error);
		}

		// Error objects can carry request details. Keep the production signal
		// without serializing a possibly secret-bearing payload into browser logs.
		console.error("Unhandled app error");
	}, [error]);

	const retry = () => {
		void router.invalidate().catch(() => reset());
	};

	return (
		<div className="min-h-dvh flex items-center justify-center p-6 bg-background">
			<div className="max-w-md w-full text-center space-y-4">
				<AlertTriangle className="size-10 text-destructive mx-auto" />
				<div>
					<h1 className="text-lg font-semibold">Page unavailable</h1>
					<p className="text-sm text-muted-foreground mt-1">
						This page couldn't load. Try again, or contact support if this continues.
					</p>
				</div>
				{isDevelopment && (
					<pre className="text-left text-xs bg-muted text-muted-foreground rounded-md p-3 overflow-auto max-h-40">
						{message}
						{digest ? `\n\ndigest: ${digest}` : ""}
					</pre>
				)}
				<Button onClick={retry} variant="default">
					<RotateCcw className="size-4" />
					Try again
				</Button>
			</div>
		</div>
	);
}
