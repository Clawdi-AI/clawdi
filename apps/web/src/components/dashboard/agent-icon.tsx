import { Laptop } from "lucide-react";
import { agentAvatarPresetSrc } from "@/lib/agent-avatar-presets";
import { cn } from "@/lib/utils";

/**
 * Per-agent brand-mark icon. Use the `size` prop — DON'T pass
 * `size-N` / `rounded-N` through `className`, those are the very
 * inconsistencies this component now controls.
 *
 * Product surfaces share one corner radius (`rounded-md`) so an agent
 * reads identically across the dashboard tile, the agent detail
 * hero, the picker dropdown, the sessions table row, and the
 * agent-target picker. Without that, screenshots from different
 * pages look like they're showing different products.
 *
 * The Discord-style sidebar rail uses `rail`: same brand art, but tuned
 * to sit inside a larger 44px hit target without visually filling it.
 *
 * Chat-bubble avatars (sessions transcript) want a circular crop
 * to match the user avatar; that one usage opts out via
 * `shape="circle"`. Everything else uses the default rounded-md.
 */

const KNOWN: ReadonlySet<string> = new Set(["claude_code", "codex", "hermes", "openclaw"]);

export type AgentIconSize = "xs" | "sm" | "md" | "lg" | "rail" | "xl";

const SIZE_CLASS: Record<AgentIconSize, string> = {
	xs: "size-4",
	sm: "size-5",
	md: "size-6",
	lg: "size-8",
	rail: "size-7",
	xl: "size-12",
};

const FALLBACK_ICON_CLASS: Record<AgentIconSize, string> = {
	xs: "size-2.5",
	sm: "size-3",
	md: "size-3.5",
	lg: "size-4",
	rail: "size-3.5",
	xl: "size-6",
};

const IDENTITY_RING_CLASS = [
	"ring-identity-1-fg/45",
	"ring-identity-2-fg/45",
	"ring-identity-3-fg/45",
	"ring-identity-4-fg/45",
	"ring-identity-5-fg/45",
	"ring-identity-6-fg/45",
	"ring-identity-7-fg/45",
	"ring-identity-8-fg/45",
] as const;

const IDENTITY_RING_WIDTH_CLASS: Record<AgentIconSize, string> = {
	xs: "ring-1",
	sm: "ring-1",
	md: "ring-1",
	lg: "ring-2",
	rail: "ring-2",
	xl: "ring-2",
};

function identityRing(seed: string | null | undefined): string | null {
	const s = seed?.trim().toLowerCase();
	if (!s) return null;
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return IDENTITY_RING_CLASS[(h >>> 7) % IDENTITY_RING_CLASS.length];
}

function imageFile(agent: string): string {
	return `/agents/${agent === "claude_code" ? "claude-code" : agent}.png`;
}

export function AgentIcon({
	agent,
	size = "md",
	shape = "rounded",
	identitySeed,
	avatarUrl,
	avatarPreset,
	className,
}: {
	agent: string | null | undefined;
	size?: AgentIconSize;
	shape?: "rounded" | "circle";
	/** Stable per-agent accent. Use an env id when available; machine name
	 * is a good fallback for historic/session rows. */
	identitySeed?: string | null;
	avatarUrl?: string | null;
	avatarPreset?: string | null;
	className?: string;
}) {
	const radius = shape === "circle" ? "rounded-full" : "rounded-md";
	const ring = size === "rail" ? null : identityRing(identitySeed);
	const railFrame = size === "rail" ? "border border-sidebar-border bg-sidebar" : null;
	const customAvatar = avatarUrl?.trim() || agentAvatarPresetSrc(avatarPreset);
	if (customAvatar) {
		return (
			<img
				src={customAvatar}
				alt=""
				draggable={false}
				className={cn(
					SIZE_CLASS[size],
					"shrink-0 bg-muted object-cover",
					radius,
					railFrame,
					ring && IDENTITY_RING_WIDTH_CLASS[size],
					ring,
					className,
				)}
			/>
		);
	}
	if (agent && KNOWN.has(agent)) {
		return (
			<img
				src={imageFile(agent)}
				alt=""
				draggable={false}
				className={cn(
					SIZE_CLASS[size],
					"shrink-0 object-cover",
					radius,
					railFrame,
					ring && IDENTITY_RING_WIDTH_CLASS[size],
					ring,
					className,
				)}
			/>
		);
	}
	return (
		<div
			className={cn(
				SIZE_CLASS[size],
				"flex shrink-0 items-center justify-center bg-muted text-muted-foreground",
				radius,
				railFrame,
				ring && IDENTITY_RING_WIDTH_CLASS[size],
				ring,
				className,
			)}
		>
			<Laptop className={FALLBACK_ICON_CLASS[size]} />
		</div>
	);
}
