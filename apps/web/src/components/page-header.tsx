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
		<div
			className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}
		>
			<div className="min-w-0 max-w-full">
				<h1 className="text-2xl font-bold tracking-tight text-pretty break-words">{title}</h1>
				{description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
			</div>
			{actions ? (
				<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
					{actions}
				</div>
			) : null}
		</div>
	);
}
