"use client";

import { AlertCircle, LogIn, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { isAuthError, normalizeBillingError } from "@/hosted/billing/errors";

/** Send the user back through Clerk, returning to wherever they are now. */
function reauthenticate() {
	if (typeof window === "undefined") return;
	const redirect = encodeURIComponent(window.location.pathname + window.location.search);
	window.location.href = `/sign-in?redirect_url=${redirect}`;
}

/** Generic card-height skeleton stack. Prefer the structural skeletons below. */
export function BillingLoading({ rows = 3 }: { rows?: number }) {
	return (
		<div data-hosted="true" className="space-y-4">
			{Array.from({ length: rows }, (_, i) => `row-${i}`).map((key) => (
				<Skeleton key={key} className="h-28 w-full rounded-lg" />
			))}
		</div>
	);
}

/** A single card skeleton (header + body lines) matching the Card primitive. */
function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
	return (
		<Card data-hosted="true" className={className}>
			<CardHeader>
				<Skeleton className="h-5 w-32" />
				<Skeleton className="h-4 w-48" />
			</CardHeader>
			<CardContent className="space-y-3">
				{Array.from({ length: lines }, (_, i) => `l-${i}`).map((key) => (
					<Skeleton key={key} className="h-4 w-full" />
				))}
			</CardContent>
		</Card>
	);
}

/** Pricing: three plan cards in the same responsive grid as the real page. */
export function PricingSkeleton() {
	return (
		<div data-hosted="true" className="grid gap-4 lg:grid-cols-3">
			<CardSkeleton lines={5} />
			<CardSkeleton lines={5} className="border-primary/40" />
			<CardSkeleton lines={4} />
		</div>
	);
}

/** Subscription: dunning slot + the current-plan card. */
export function SubscriptionSkeleton() {
	return (
		<div data-hosted="true" className="space-y-6">
			<CardSkeleton lines={4} />
		</div>
	);
}

/** Wallet: balance hero + the auto-reload / x402 row + the activity table. */
export function WalletSkeleton() {
	return (
		<div data-hosted="true" className="space-y-6">
			<Skeleton className="h-28 w-full rounded-lg" />
			<div className="grid gap-4 lg:grid-cols-2">
				<CardSkeleton lines={3} />
				<CardSkeleton lines={2} />
			</div>
			<Skeleton className="h-64 w-full rounded-lg" />
		</div>
	);
}

/** Usage: total cards + daily chart + by-model rows. */
export function UsageSkeleton() {
	return (
		<div data-hosted="true" className="space-y-6">
			<div className="grid gap-3 sm:grid-cols-2">
				<CardSkeleton lines={1} />
				<CardSkeleton lines={1} />
			</div>
			<Card data-hosted="true">
				<CardHeader>
					<Skeleton className="h-5 w-36" />
				</CardHeader>
				<CardContent>
					<div className="flex h-28 items-end gap-1">
						{Array.from({ length: 14 }, (_, i) => `day-${i}`).map((key, index) => (
							<Skeleton
								key={key}
								className="flex-1 rounded-t"
								style={{ height: `${Math.max(16, ((index % 7) + 2) * 10)}%` }}
							/>
						))}
					</div>
					<div className="mt-2 flex justify-between">
						<Skeleton className="h-3 w-10" />
						<Skeleton className="h-3 w-10" />
					</div>
				</CardContent>
			</Card>
			<CardSkeleton lines={5} />
		</div>
	);
}

/**
 * Normalized error panel with an optional retry. When the failure is a
 * session-expiry 401 we lead with a "Sign in again" action (a fresh retry
 * can't fix a dead token) and keep Retry as a secondary affordance for the
 * race where Clerk has already refreshed the token in the background.
 */
export function BillingError({
	error,
	onRetry,
	title = "Couldn’t load this",
}: {
	error: unknown;
	onRetry?: () => void;
	title?: string;
}) {
	const expired = isAuthError(error);
	return (
		<Alert data-hosted="true" variant="destructive">
			<AlertCircle />
			<AlertTitle>{expired ? "Your session expired" : title}</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-3">
				<span>{normalizeBillingError(error)}</span>
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

/**
 * Empty-state block for a billing surface. Built on the design-system `Empty`
 * primitive (icon chip + title + description + optional action) so it matches
 * the empty states used across the OSS dashboard.
 */
export function BillingEmpty({
	icon,
	title,
	description,
	action,
}: {
	icon?: ReactNode;
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<Empty data-hosted="true" className="border">
			<EmptyHeader>
				{icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
				<EmptyTitle>{title}</EmptyTitle>
				{description ? <EmptyDescription>{description}</EmptyDescription> : null}
			</EmptyHeader>
			{action ? <EmptyContent>{action}</EmptyContent> : null}
		</Empty>
	);
}
