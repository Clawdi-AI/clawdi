"use client";

import * as Sentry from "@sentry/tanstackstart-react";
import { useRouter } from "@tanstack/react-router";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

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
export default function RootError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	const router = useRouter();

	useEffect(() => {
		if (import.meta.env.VITE_SENTRY_DSN) {
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
					<h1 className="text-lg font-semibold">Page Unavailable</h1>
					<p className="text-sm text-muted-foreground mt-1">
						The page couldn&apos;t render. Try again. If it keeps failing, check the browser console
						and backend logs for the request ID.
					</p>
				</div>
				{isDevelopment && (
					<pre className="text-left text-xs bg-muted text-muted-foreground rounded-md p-3 overflow-auto max-h-40">
						{error.message}
						{error.digest ? `\n\ndigest: ${error.digest}` : ""}
					</pre>
				)}
				<Button onClick={retry} variant="default">
					<RotateCcw className="size-4" />
					Try Again
				</Button>
			</div>
		</div>
	);
}
