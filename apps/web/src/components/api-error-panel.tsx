"use client";

import { AlertCircle, LogIn, type LucideIcon, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isApiAuthError, normalizeApiError } from "@/lib/api-errors";
import { env } from "@/lib/env";

export interface ApiErrorNormalizer {
	isAuthError: (error: unknown) => boolean;
	normalizeError: (error: unknown) => string;
}

const DEFAULT_API_ERROR_NORMALIZER: ApiErrorNormalizer = {
	isAuthError: isApiAuthError,
	normalizeError: normalizeApiError,
};

/** Restore Desktop auth from the CLI before asking for a new browser sign-in. */
function reauthenticate() {
	if (typeof window === "undefined") return;
	if (window.clawdiDesktop) {
		void window.clawdiDesktop.retryDashboard().catch(() => {
			window.location.href = "/sign-in";
		});
		return;
	}
	const redirect = encodeURIComponent(window.location.pathname + window.location.search);
	window.location.href = `/sign-in?redirect_url=${redirect}`;
}

/** Shared API error chrome with an optional domain-specific normalizer. */
export function ApiErrorPanel({
	error,
	onRetry,
	title = "Couldn't load this",
	normalizer = DEFAULT_API_ERROR_NORMALIZER,
	icon: Icon = AlertCircle,
}: {
	error: unknown;
	onRetry?: () => void;
	title?: string;
	normalizer?: ApiErrorNormalizer;
	icon?: LucideIcon;
}) {
	const expired = normalizer.isAuthError(error);
	return (
		<Alert variant="destructive">
			<Icon />
			<AlertTitle>{expired ? "Your session expired" : title}</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-3">
				<span className="min-w-0 [overflow-wrap:anywhere]">{normalizer.normalizeError(error)}</span>
				<div className="flex flex-wrap gap-2">
					{expired ? (
						<Button size="sm" onClick={reauthenticate}>
							<LogIn /> {env.VITE_CLAWDI_DESKTOP_BUILD ? "Reconnect" : "Sign in again"}
						</Button>
					) : null}
					{onRetry ? (
						<Button size="sm" variant="outline" onClick={onRetry}>
							<RefreshCw /> Retry
						</Button>
					) : null}
				</div>
			</AlertDescription>
		</Alert>
	);
}
