"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
	CODEX_OAUTH_CHANNEL,
	CODEX_OAUTH_STORAGE_KEY,
	type CodexOAuthResult,
	parseCodexCallback,
} from "@/hosted/v2/ai-providers/codex-oauth";

/**
 * The Codex OAuth landing page. ChatGPT redirects here with `?code&state`;
 * this hands them back to the add-provider dialog (the opener) over three
 * channels for resilience — postMessage to the opener, a BroadcastChannel,
 * and localStorage — then closes itself when it was opened as a popup.
 */
export function CodexOAuthCallback() {
	const [state, setState] = useState<"ok" | "error">("ok");

	useEffect(() => {
		const parsed = parseCodexCallback(window.location.href);
		const result: CodexOAuthResult = parsed ?? {
			code: "",
			state: "",
			error: "missing_code",
		};
		setState(result.error || !result.code ? "error" : "ok");

		try {
			const ch = new BroadcastChannel(CODEX_OAUTH_CHANNEL);
			ch.postMessage(result);
			ch.close();
		} catch {
			// BroadcastChannel unsupported — the other channels still cover it.
		}
		try {
			window.opener?.postMessage(
				{ source: CODEX_OAUTH_CHANNEL, ...result },
				window.location.origin,
			);
		} catch {
			// Cross-origin opener — ignore; storage/broadcast still deliver.
		}
		try {
			localStorage.setItem(CODEX_OAUTH_STORAGE_KEY, JSON.stringify(result));
		} catch {
			// Storage blocked — best-effort only.
		}

		// Opened as a popup with a usable result → auto-close shortly.
		if (window.opener && !result.error && result.code) {
			const t = setTimeout(() => window.close(), 1000);
			return () => clearTimeout(t);
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
						state === "ok" ? "bg-success-muted text-success" : "bg-destructive/10 text-destructive"
					}`}
				>
					{state === "ok" ? <CircleCheck className="size-5" /> : <CircleAlert className="size-5" />}
				</span>
				<h1 className="mt-3 text-sm font-semibold">
					{state === "ok" ? "Signed in to ChatGPT" : "Sign-in didn’t complete"}
				</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					{state === "ok"
						? "You can close this window and return to Clawdi — your provider is connecting."
						: "Return to Clawdi and try again, or paste this page’s URL into the dialog."}
				</p>
			</div>
		</div>
	);
}
