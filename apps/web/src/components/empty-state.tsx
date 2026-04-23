import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
	icon?: LucideIcon;
	title?: string;
	description?: ReactNode;
	action?: ReactNode;
	className?: string;
}

/**
 * Dashed-border empty state tile. Single component replaces ~10 inline
 * `<div className="rounded-lg border border-dashed p-6 text-center ...">`
 * duplicates across pages. Icon + title + description + optional action
 * slot is the canonical shadcn-ish pattern for "nothing here yet".
 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
	return (
		<div
			className={cn(
				"mx-auto flex max-w-md flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-card p-8 text-center",
				className,
			)}
		>
			{Icon ? <Icon className="size-8 text-muted-foreground/60" aria-hidden /> : null}
			{title ? <p className="text-sm font-medium">{title}</p> : null}
			{description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
			{action ? <div className="mt-2">{action}</div> : null}
		</div>
	);
}
