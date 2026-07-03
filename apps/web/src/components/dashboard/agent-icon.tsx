import { Laptop } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Per-agent brand-mark icon. Product surfaces share one corner radius by
 * default; transcript bubbles can opt into a circular crop.
 */

const KNOWN: ReadonlySet<string> = new Set([
	"claude-code",
	"claude_code",
	"codex",
	"hermes",
	"openclaw",
]);

export type AgentIconSize = "xs" | "sm" | "md" | "lg" | "rail" | "xl";

const SIZE_CLASS: Record<AgentIconSize, string> = {
	xs: "size-4",
	sm: "size-5",
	md: "size-6",
	lg: "size-8",
	rail: "size-9",
	xl: "size-12",
};

const SIZE_PX: Record<AgentIconSize, number> = {
	xs: 16,
	sm: 20,
	md: 24,
	lg: 32,
	rail: 36,
	xl: 48,
};

const FALLBACK_ICON_CLASS: Record<AgentIconSize, string> = {
	xs: "size-2.5",
	sm: "size-3",
	md: "size-3.5",
	lg: "size-4",
	rail: "size-4.5",
	xl: "size-6",
};

function imageFile(agent: string): string {
	return `/agents/${agent === "claude_code" ? "claude-code" : agent}.png`;
}

export function AgentIcon({
	agent,
	size = "md",
	shape = "rounded",
	avatarUrl,
	className,
}: {
	agent: string | null | undefined;
	size?: AgentIconSize;
	shape?: "rounded" | "circle";
	avatarUrl?: string | null;
	className?: string;
}) {
	const radius = shape === "circle" ? "rounded-full" : "rounded-md";
	const customAvatar = avatarUrl?.trim();
	const pixelSize = SIZE_PX[size];
	if (customAvatar) {
		return (
			<img
				src={customAvatar}
				alt=""
				width={pixelSize}
				height={pixelSize}
				draggable={false}
				className={cn(SIZE_CLASS[size], "shrink-0 bg-muted object-cover", radius, className)}
			/>
		);
	}
	if (agent && KNOWN.has(agent)) {
		return (
			<img
				src={imageFile(agent)}
				alt=""
				width={pixelSize}
				height={pixelSize}
				draggable={false}
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
