import { Laptop } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const AGENT_FRAMEWORK_PNG: Record<string, string> = {
	openclaw: "/agents/openclaw.png",
	hermes: "/agents/hermes.png",
	"claude-code": "/agents/claude-code.png",
	claude_code: "/agents/claude-code.png",
	codex: "/agents/codex.png",
};

function agentFrameworkIconSrc(agent: string | null | undefined): string | null {
	const key = agent?.toLowerCase?.() ?? "";
	return AGENT_FRAMEWORK_PNG[key] ?? null;
}

function fallbackContent({
	fallback,
	label,
	fallbackIconClassName,
}: {
	fallback: "device" | "monogram";
	label: string;
	fallbackIconClassName?: string;
}): ReactNode {
	if (fallback === "monogram") return label.trim().charAt(0).toUpperCase() || "?";
	return <Laptop className={fallbackIconClassName} />;
}

/**
 * One renderer for local `/agents/*.png` framework marks. Callers provide their
 * own size/radius classes because sidebar labels and entity cards intentionally
 * use different scales, but the source map and unknown-agent fallback decision
 * stay here.
 */
export function AgentFrameworkIcon({
	agent,
	label,
	alt = "",
	pixelSize,
	boxClassName,
	fallbackIconClassName,
	fallback = "device",
	avatarUrl,
	className,
	draggable = false,
}: {
	agent: string | null | undefined;
	label?: string | null;
	alt?: string;
	pixelSize: number;
	boxClassName: string;
	fallbackIconClassName?: string;
	fallback?: "device" | "monogram";
	avatarUrl?: string | null;
	className?: string;
	draggable?: boolean;
}) {
	const customAvatar = avatarUrl?.trim();
	if (customAvatar) {
		return (
			<img
				src={customAvatar}
				alt={alt}
				width={pixelSize}
				height={pixelSize}
				draggable={draggable}
				className={cn(boxClassName, "shrink-0 bg-muted object-cover", className)}
			/>
		);
	}

	const src = agentFrameworkIconSrc(agent);
	if (src) {
		return (
			<img
				src={src}
				alt={alt}
				width={pixelSize}
				height={pixelSize}
				draggable={draggable}
				className={cn(boxClassName, "shrink-0 object-cover", className)}
			/>
		);
	}

	return (
		<div
			className={cn(
				boxClassName,
				"flex shrink-0 items-center justify-center bg-muted font-semibold text-muted-foreground",
				className,
			)}
		>
			{fallbackContent({
				fallback,
				label: label ?? agent ?? "",
				fallbackIconClassName,
			})}
		</div>
	);
}
