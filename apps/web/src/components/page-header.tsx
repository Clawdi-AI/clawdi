import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
	title: string;
	description?: string;
	actions?: ReactNode;
	className?: string;
}

/**
 * Canonical dashboard page header: title + description on the left, action
 * slot on the right. Matches the header pattern used across shadcn example
 * dashboards so every page stays visually consistent.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
	return (
		<div className={cn("flex items-start justify-between gap-4", className)}>
			<div className="min-w-0">
				<h1 className="text-2xl font-bold tracking-tight">{title}</h1>
				{description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
			</div>
			{actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
		</div>
	);
}
