"use client";

import { Check, CircleAlert, CircleCheck, Copy, TriangleAlert } from "lucide-react";
import { EntityIcon, type EntityIconSize } from "@/components/entity-icon";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import { cn } from "@/lib/utils";

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
		<StatusBadge status={owner ? "info" : "neutral"}>
			{owner ? "Your bot" : "Ready to use"}
		</StatusBadge>
	);
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
			onClick={() => copy(value)}
			className={cn(
				"inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground",
				className,
			)}
			aria-label={`Copy ${label}`}
		>
			<span className="truncate">{value}</span>
			{copied ? <Check className="size-3 shrink-0" /> : <Copy className="size-3 shrink-0" />}
		</button>
	);
}
