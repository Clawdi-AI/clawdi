import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
	title: string;
	description?: string;
	actions?: ReactNode;
	/** Left-of-title slot — e.g. a channel or runtime icon. */
	icon?: ReactNode;
	/** Meta row rendered under the title — status badges, runtime/compute, etc. */
	status?: ReactNode;
	className?: string;
}

/**
 * Canonical dashboard page header: title + description on the left, action
 * slot on the right. Detail pages can add a left `icon` (icon cluster)
 * and a `status` meta row under the title so every header shares one chassis.
 * Matches the header pattern used across shadcn example dashboards so every
 * page stays visually consistent.
 */
export function PageHeader({
	title,
	description,
	actions,
	icon,
	status,
	className,
}: PageHeaderProps) {
	return (
		<div
			className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}
		>
			<div className="flex min-w-0 items-center gap-3">
				{icon ? <div className="shrink-0">{icon}</div> : null}
				<div className="min-w-0 max-w-full">
					<h1 className="text-xl font-semibold tracking-tight text-pretty break-words">{title}</h1>
					{description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
					{status ? <div className="mt-1">{status}</div> : null}
				</div>
			</div>
			{actions ? (
				<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
					{actions}
				</div>
			) : null}
		</div>
	);
}
