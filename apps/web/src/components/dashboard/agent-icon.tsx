import { Laptop } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Per-agent brand-mark icon. Use the `size` prop — DON'T pass
 * `size-N` / `rounded-N` through `className`, those are the very
 * inconsistencies this component now controls.
 *
 * Five sizes share one corner radius (`rounded-md`) so an agent
 * reads identically across the dashboard tile, the agent detail
 * hero, the picker dropdown, the sessions table row, and the
 * agent-target picker. Without that, screenshots from different
 * pages look like they're showing different products.
 *
 * Chat-bubble avatars (sessions transcript) want a circular crop
 * to match the user avatar; that one usage opts out via
 * `shape="circle"`. Everything else uses the default rounded-md.
 */

const KNOWN: ReadonlySet<string> = new Set(["claude_code", "codex", "hermes", "openclaw"]);

export type AgentIconSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<AgentIconSize, string> = {
	xs: "size-4",
	sm: "size-5",
	md: "size-6",
	lg: "size-8",
	xl: "size-12",
};

const FALLBACK_ICON_CLASS: Record<AgentIconSize, string> = {
	xs: "size-2.5",
	sm: "size-3",
	md: "size-3.5",
	lg: "size-4",
	xl: "size-6",
};

function imageFile(agent: string): string {
	return `/agents/${agent === "claude_code" ? "claude-code" : agent}.png`;
}

export function AgentIcon({
	agent,
	size = "md",
	shape = "rounded",
	className,
}: {
	agent: string | null | undefined;
	size?: AgentIconSize;
	shape?: "rounded" | "circle";
	className?: string;
}) {
	const radius = shape === "circle" ? "rounded-full" : "rounded-md";
	if (agent && KNOWN.has(agent)) {
		return (
			<img
				src={imageFile(agent)}
				alt=""
				className={cn(SIZE_CLASS[size], "shrink-0 object-cover", radius, className)}
			/>
		);
	}
	return (
		<div
			className={cn(
				SIZE_CLASS[size],
				"flex shrink-0 items-center justify-center bg-muted text-muted-foreground",
				radius,
				className,
			)}
		>
			<Laptop className={FALLBACK_ICON_CLASS[size]} />
		</div>
	);
}
