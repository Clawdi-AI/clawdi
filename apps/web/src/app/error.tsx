"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Root error boundary for the whole app.
 *
 * Next.js catches any unhandled render/data error and mounts this component
 * with the error + a `reset()` to retry. Keeping it minimal: user sees a
 * clear message + a retry button + a dev-only error detail, nothing more.
 */
export default function RootError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("Unhandled app error:", error);
	}, [error]);

	return (
		<div className="min-h-screen flex items-center justify-center p-6 bg-background">
			<div className="max-w-md w-full text-center space-y-4">
				<AlertTriangle className="size-10 text-destructive mx-auto" />
				<div>
					<h1 className="text-lg font-semibold">Something broke</h1>
					<p className="text-sm text-muted-foreground mt-1">
						The page couldn't render. Retry — if it keeps failing, check the browser console and
						backend logs for the request ID.
					</p>
				</div>
				{process.env.NODE_ENV !== "production" && (
					<pre className="text-left text-xs bg-muted text-muted-foreground rounded-md p-3 overflow-auto max-h-40">
						{error.message}
						{error.digest ? `\n\ndigest: ${error.digest}` : ""}
					</pre>
				)}
				<Button onClick={reset} variant="default">
					<RotateCcw className="size-4" />
					Try again
				</Button>
			</div>
		</div>
	);
}
