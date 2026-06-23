"use client";

import {
	Check,
	CircleAlert,
	CircleCheck,
	Copy,
	LogIn,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";
import { EntityIcon, type EntityIconSize } from "@/components/entity-icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { isApiAuthError, normalizeApiError } from "@/lib/api-errors";
import { cn } from "@/lib/utils";
import { providerMeta } from "@/v2/channels/channel-providers";

type StatusTone = "success" | "warning" | "destructive" | "info" | "neutral";

/** Send the user back through Clerk, returning to wherever they are now. */
function reauthenticate() {
	if (typeof window === "undefined") return;
	const redirect = encodeURIComponent(window.location.pathname + window.location.search);
	window.location.href = `/sign-in?redirect_url=${redirect}`;
}

/**
 * Cloud-api error panel for the v2 channel / provider surfaces. Normalizes
 * the failure to internal-free copy and, on a session-expiry 401, leads with a
 * "Sign in again" action (a retry can't fix a dead token) while keeping Retry
 * as a secondary affordance for the race where Clerk already refreshed it.
 */
export function ChannelError({
	error,
	onRetry,
	title = "Couldn't load this",
}: {
	error: unknown;
	onRetry?: () => void;
	title?: string;
}) {
	const expired = isApiAuthError(error);
	return (
		<Alert data-v2="true" variant="destructive">
			<CircleAlert />
			<AlertTitle>{expired ? "Your session expired" : title}</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-3">
				<span>{normalizeApiError(error)}</span>
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

/** Real app-icon for a channel provider (delegates to the unified EntityIcon). */
export function ProviderChip({
	provider,
	size = "md",
	className,
}: {
	provider: string;
	size?: EntityIconSize;
	className?: string;
}) {
	const meta = providerMeta(provider);
	return (
		<EntityIcon kind="channel" id={provider} label={meta.label} size={size} className={className} />
	);
}

const HEALTH_META: Record<string, { label: string; tone: StatusTone; icon: typeof CircleCheck }> = {
	ok: { label: "Healthy", tone: "success", icon: CircleCheck },
	warning: { label: "Warning", tone: "warning", icon: TriangleAlert },
	error: { label: "Error", tone: "destructive", icon: CircleAlert },
};

/** Health chip (ok / warning / error) from `GET /api/channels/health`. */
export function HealthBadge({ status, className }: { status: string; className?: string }) {
	const m = HEALTH_META[status] ?? HEALTH_META.warning;
	const Icon = m.icon;
	return (
		<StatusBadge status={m.tone} className={className}>
			<Icon />
			{m.label}
		</StatusBadge>
	);
}

/** Owner / shared access label for pool items. */
export function AccessBadge({ access }: { access: string }) {
	const owner = access === "owner";
	return (
		<StatusBadge status={owner ? "info" : "neutral"}>{owner ? "Your bot" : "Shared"}</StatusBadge>
	);
}

const DELIVERY_TONE: Record<string, StatusTone> = {
	sent: "success",
	delivered: "success",
	pending: "warning",
	in_progress: "warning",
	failed: "destructive",
};

/** Delivery state chip for activity rows. */
export function DeliveryBadge({ status }: { status: string }) {
	return (
		<StatusBadge status={DELIVERY_TONE[status] ?? "neutral"}>
			{status.replace("_", " ")}
		</StatusBadge>
	);
}

function useCopy() {
	return useCopyToClipboard({ error: "Copy failed" });
}

/** Copyable secret box — used for revealed agent tokens, webhook secrets. */
export function TokenReveal({
	label,
	value,
	note,
}: {
	label: string;
	value: string;
	note?: string;
}) {
	const { copied, copy } = useCopy();
	return (
		<div data-v2="true" className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
			<div className="text-xs font-medium text-primary">{label}</div>
			<div className="flex items-center gap-2">
				<code className="flex-1 break-all rounded bg-muted px-3 py-2 font-mono text-xs">
					{value}
				</code>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={() => copy(value)}
					aria-label={`Copy ${label}`}
				>
					{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
				</Button>
			</div>
			{note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
		</div>
	);
}

/** Inline copyable monospace value (chat ids, webhook urls). */
export function CopyInline({ value, className }: { value: string; className?: string }) {
	const { copied, copy } = useCopy();
	return (
		<button
			type="button"
			data-v2="true"
			onClick={() => copy(value)}
			className={cn(
				"inline-flex items-center gap-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground",
				className,
			)}
			aria-label="Copy"
		>
			<span className="truncate">{value}</span>
			{copied ? <Check className="size-3 shrink-0" /> : <Copy className="size-3 shrink-0" />}
		</button>
	);
}
