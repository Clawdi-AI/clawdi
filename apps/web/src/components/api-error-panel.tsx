"use client";

import { AlertCircle, LogIn, type LucideIcon, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isApiAuthError, normalizeApiError } from "@/lib/api-errors";

export interface ApiErrorNormalizer {
	isAuthError: (error: unknown) => boolean;
	normalizeError: (error: unknown) => string;
}

const DEFAULT_API_ERROR_NORMALIZER: ApiErrorNormalizer = {
	isAuthError: isApiAuthError,
	normalizeError: normalizeApiError,
};

/** Send the user back through Clerk, returning to wherever they are now. */
function reauthenticate() {
	if (typeof window === "undefined") return;
	const redirect = encodeURIComponent(window.location.pathname + window.location.search);
	window.location.href = `/sign-in?redirect_url=${redirect}`;
}

/**
 * Hosted API error panel. The chrome is shared; the `kind` selects the
 * product-specific normalizer so billing can keep its wallet copy while
 * channel/provider surfaces keep the general cloud-api copy.
 */
export function ApiErrorPanel({
	error,
	onRetry,
	title = "Couldn't load this",
	normalizer = DEFAULT_API_ERROR_NORMALIZER,
	dataV2,
	icon: Icon = AlertCircle,
}: {
	error: unknown;
	onRetry?: () => void;
	title?: string;
	normalizer?: ApiErrorNormalizer;
	dataV2?: boolean;
	icon?: LucideIcon;
}) {
	const expired = normalizer.isAuthError(error);
	const isV2 = dataV2 ?? normalizer === DEFAULT_API_ERROR_NORMALIZER;
	return (
		<Alert data-hosted="true" data-v2={isV2 ? "true" : undefined} variant="destructive">
			<Icon />
			<AlertTitle>{expired ? "Your session expired" : title}</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-3">
				<span>{normalizer.normalizeError(error)}</span>
				<div className="flex flex-wrap gap-2">
					{expired ? (
						<Button size="sm" onClick={reauthenticate}>
							<LogIn /> Sign in again
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
