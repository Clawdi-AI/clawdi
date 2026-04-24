import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
	icon?: LucideIcon;
	title?: string;
	description?: ReactNode;
	action?: ReactNode;
	/** When set, wraps in a rounded muted tile. Default is flat — just centered text. */
	bordered?: boolean;
	/**
	 * When true (default), reserve vertical space so the hint sits mid-pane
	 * instead of floating near the top. Set false inside cards / sub-regions
	 * where surrounding chrome already sets the visual weight.
	 */
	fillHeight?: boolean;
	className?: string;
}

/**
 * Centered empty-state message. Flat by default — a minimal hint, not a
 * heavy dashed box. Opt-in `bordered` switches it to a subtle bordered tile
 * for cases where the surrounding layout needs visible structure.
 */
export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	bordered = false,
	fillHeight = true,
	className,
}: EmptyStateProps) {
	return (
		<div
			className={cn(
				"mx-auto flex w-full max-w-md flex-col items-center justify-center gap-2 text-center",
				fillHeight ? "min-h-[320px] py-10" : "py-8",
				bordered && "rounded-lg border border-dashed bg-muted/20",
				className,
			)}
		>
			{Icon ? <Icon className="size-8 text-muted-foreground/60" aria-hidden /> : null}
			{title ? <p className="text-sm font-medium">{title}</p> : null}
			{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
			{action ? <div className="mt-2">{action}</div> : null}
		</div>
	);
}
