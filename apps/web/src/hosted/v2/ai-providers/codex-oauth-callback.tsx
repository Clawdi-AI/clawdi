"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
	CODEX_OAUTH_CHANNEL,
	type CodexOAuthResult,
	parseCodexCallback,
	sanitizeCodexCallbackHistoryUrl,
} from "@/hosted/v2/ai-providers/codex-oauth";

/** Compatibility-only relay for PKCE flows started before device flow became the default. */
export function CodexOAuthCallback() {
	const [status, setStatus] = useState<"ok" | "error">("ok");

	useEffect(() => {
		const parsed = parseCodexCallback(window.location.href);
		const result: CodexOAuthResult = parsed ?? {
			code: "",
			state: "",
			error: "missing_code",
		};
		// Remove authorization material from history before relaying it in memory.
		window.history.replaceState(
			window.history.state,
			"",
			sanitizeCodexCallbackHistoryUrl(window.location.href),
		);
		setStatus(result.error || !result.code ? "error" : "ok");

		try {
			const channel = new BroadcastChannel(CODEX_OAUTH_CHANNEL);
			channel.postMessage(result);
			channel.close();
		} catch {
			// The same-origin opener channel below remains available.
		}
		try {
			window.opener?.postMessage(
				{ source: CODEX_OAUTH_CHANNEL, ...result },
				window.location.origin,
			);
		} catch {
			// A missing or cross-origin legacy opener cannot receive the relay.
		}
		if (window.opener && !result.error && result.code) {
			const timer = setTimeout(() => window.close(), 1_000);
			return () => clearTimeout(timer);
		}
	}, []);

	return (
		<div
			data-hosted="true"
			data-v2="true"
			className="flex min-h-dvh items-center justify-center bg-background p-6"
		>
			<div className="w-full max-w-sm rounded-lg border bg-card p-6 text-center">
				<span
					className={`mx-auto flex size-10 items-center justify-center rounded-full ${
						status === "ok" ? "bg-success-muted text-success" : "bg-destructive/10 text-destructive"
					}`}
				>
					{status === "ok" ? (
						<CircleCheck className="size-5" />
					) : (
						<CircleAlert className="size-5" />
					)}
				</span>
				<h1 className="mt-3 text-sm font-semibold">
					{status === "ok" ? "Signed in to ChatGPT" : "Sign-in didn’t complete"}
				</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					{status === "ok"
						? "Return to the Clawdi window that started this sign-in."
						: "Return to Clawdi and start a new ChatGPT connection."}
				</p>
			</div>
		</div>
	);
}
