"use client";

import { Check, CircleAlert, CircleCheck, Copy, TriangleAlert } from "lucide-react";
import { EntityIcon, type EntityIconSize } from "@/components/entity-icon";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { channelHealthSummary } from "@/hosted/v2/channels/channel-health-summary";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import type { ChannelHealthItem } from "@/hosted/v2/channels/channel-types";
import { cn } from "@/lib/utils";

export const CHANNEL_DESTRUCTIVE_ACTION_CLASS =
	"text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive";

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

const HEALTH_META: Record<string, { tone: StatusTone; icon: typeof CircleCheck }> = {
	ok: { tone: "success", icon: CircleCheck },
	warning: { tone: "warning", icon: TriangleAlert },
	error: { tone: "destructive", icon: CircleAlert },
};

/** Health chip (ok / warning / error) from `GET /v1/channels/health`. */
export function HealthBadge({
	health,
	className,
}: {
	health: ChannelHealthItem;
	className?: string;
}) {
	const m = HEALTH_META[health.health_status] ?? HEALTH_META.warning;
	const summary = channelHealthSummary(health);
	const Icon = m.icon;
	return (
		<StatusBadge
			status={m.tone}
			className={className}
			title={summary.detail}
			aria-label={`${summary.label}. ${summary.detail}`}
		>
			<Icon aria-hidden="true" />
			{summary.label}
		</StatusBadge>
	);
}

export function isNormalChannelHealth(status: string | null | undefined): boolean {
	return status?.toLowerCase() === "ok";
}

const CHANNEL_STATUS_TONE: Record<string, StatusTone> = {
	active: "success",
	connected: "success",
	paired: "success",
	pending: "warning",
	pairing: "warning",
	error: "destructive",
	failed: "destructive",
	revoked: "destructive",
};

/** Account, agent-link, and chat-binding lifecycle status. */
export function ChannelStatusBadge({ status, className }: { status: string; className?: string }) {
	return (
		<StatusBadge
			status={CHANNEL_STATUS_TONE[status.toLowerCase()] ?? "neutral"}
			className={className}
		>
			<span className="capitalize">{status}</span>
		</StatusBadge>
	);
}

export function isNormalChannelStatus(status: string | null | undefined): boolean {
	return ["active", "connected", "paired"].includes(status?.toLowerCase() ?? "");
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

/** Inline copyable monospace value (chat ids, ids, urls). */
export function CopyInline({
	value,
	label,
	className,
}: {
	value: string;
	label: string;
	className?: string;
}) {
	const { copied, copy } = useCopy();
	return (
		<button
			type="button"
			data-hosted="true"
			data-v2="true"
			onClick={() => void copy(value)}
			className={cn(
				"inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				className,
			)}
			aria-label={copied ? `${label} copied` : `Copy ${label}`}
			title={copied ? `${label} copied` : `Copy ${label}`}
		>
			<code className="truncate">{value}</code>
			{copied ? (
				<Check className="size-3 shrink-0" aria-hidden="true" />
			) : (
				<Copy className="size-3 shrink-0" aria-hidden="true" />
			)}
			<span className="sr-only" aria-live="polite">
				{copied ? `${label} copied` : ""}
			</span>
		</button>
	);
}
