import { Laptop } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Per-agent logo tile for AgentTile. Fills the whole tile — image
 * clipped to a small rounded-md corner, no padding, no frame. Each
 * brand PNG carries its own backdrop; logos that lack one fall through
 * to the parent card's bg.
 */

const KNOWN: ReadonlySet<string> = new Set(["claude_code", "codex", "hermes", "openclaw"]);

function imageFile(agent: string): string {
	// claude_code uses a hyphen in the filename to match the brand wordmark.
	return `/agents/${agent === "claude_code" ? "claude-code" : agent}.png`;
}

export function AgentIcon({
	agent,
	className,
}: {
	agent: string | null | undefined;
	className?: string;
}) {
	if (agent && KNOWN.has(agent)) {
		return (
			<img
				src={imageFile(agent)}
				alt=""
				className={cn("size-8 shrink-0 rounded-md object-cover", className)}
			/>
		);
	}

	return (
		<div
			className={cn(
				"flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
				className,
			)}
		>
			<Laptop className="size-4" />
		</div>
	);
}
