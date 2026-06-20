"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";

interface TurnstileApi {
	render: (
		el: HTMLElement,
		opts: {
			sitekey: string;
			callback: (token: string) => void;
			"expired-callback"?: () => void;
			"error-callback"?: () => void;
			theme?: "auto" | "light" | "dark";
		},
	) => string;
	remove: (id: string) => void;
	reset: (id?: string) => void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
let scriptPromise: Promise<void> | null = null;

function ensureScript(): Promise<void> {
	if (typeof window === "undefined") return Promise.resolve();
	if (window.turnstile) return Promise.resolve();
	if (scriptPromise) return scriptPromise;
	scriptPromise = new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = SCRIPT_SRC;
		script.async = true;
		script.defer = true;
		script.onload = () => resolve();
		script.onerror = () => {
			script.remove();
			scriptPromise = null;
			reject(new Error("Failed to load Turnstile"));
		};
		document.head.appendChild(script);
	});
	return scriptPromise;
}

/**
 * Cloudflare Turnstile challenge for the redemption flow. Only mounted when the
 * backend returns `turnstile_required` (risk-triggered after repeated invalid
 * attempts). The site key is a public env var since the backend doesn't expose
 * one; absent it, we show a clear retry-later message so the build stays clean.
 */
export function TurnstileWidget({ onToken }: { onToken: (token: string) => void }) {
	const siteKey = env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
	const ref = useRef<HTMLDivElement>(null);
	const widgetId = useRef<string | null>(null);
	// Surface a script-load / widget failure so the redeem flow never stalls on
	// an invisible, silently-broken challenge box.
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!siteKey) return;
		const container = ref.current;
		if (!container) return;
		let cancelled = false;
		setFailed(false);
		ensureScript()
			.then(() => {
				if (cancelled || !window.turnstile) return;
				widgetId.current = window.turnstile.render(container, {
					sitekey: siteKey,
					callback: (token) => onToken(token),
					"expired-callback": () => onToken(""),
					// A widget runtime error invalidates any held token and tells the
					// user to retry, rather than leaving a dead challenge on screen.
					"error-callback": () => {
						onToken("");
						if (!cancelled) setFailed(true);
					},
					theme: "auto",
				});
			})
			.catch(() => {
				// Script blocked (ad-blocker / network) — show the recovery message.
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
			if (widgetId.current && window.turnstile) {
				window.turnstile.remove(widgetId.current);
				widgetId.current = null;
			}
		};
	}, [siteKey, onToken, attempt]);

	if (!siteKey) {
		return (
			<p data-hosted="true" className="text-sm text-warning-muted-foreground">
				We need to verify it’s really you, but verification isn’t configured here. Please try again
				later or contact support.
			</p>
		);
	}

	if (failed) {
		return (
			<div data-hosted="true" className="space-y-2">
				<p className="text-sm text-warning-muted-foreground">
					We couldn’t load the verification challenge. Disable any ad-blocker for this page and try
					again, or come back in a moment.
				</p>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => {
						setFailed(false);
						setAttempt((value) => value + 1);
					}}
				>
					Retry verification
				</Button>
			</div>
		);
	}

	return <div data-hosted="true" ref={ref} className="min-h-[65px]" />;
}
