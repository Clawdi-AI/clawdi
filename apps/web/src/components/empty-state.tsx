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
	className,
}: EmptyStateProps) {
	return (
		<div
			className={cn(
				"mx-auto flex max-w-md flex-col items-center justify-center gap-2 py-8 text-center",
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
