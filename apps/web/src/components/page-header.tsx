import type { ReactNode } from "react";
import { HeaderActionGroup } from "@/components/header-action-group";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
	title: string;
	titleAdornment?: ReactNode;
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
	titleAdornment,
	description,
	actions,
	icon,
	status,
	className,
}: PageHeaderProps) {
	return (
		<div
			data-slot="page-header"
			className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}
		>
			<div className="flex min-w-0 items-center gap-3">
				{icon ? <div className="shrink-0">{icon}</div> : null}
				<div className="min-w-0 max-w-full">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<h1 className="text-xl font-semibold tracking-tight text-pretty break-words">
							{title}
						</h1>
						{titleAdornment}
					</div>
					{description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
					{status ? <div className="mt-1">{status}</div> : null}
				</div>
			</div>
			{actions ? <HeaderActionGroup>{actions}</HeaderActionGroup> : null}
		</div>
	);
}

/** Loading counterpart to PageHeader. It keeps the same responsive geometry so
 * route-level Suspense boundaries and data loading do not shift the page. */
export function PageHeaderSkeleton({
	icon = false,
	actions = false,
	description = true,
	iconClassName,
	className,
}: {
	icon?: boolean;
	actions?: boolean;
	description?: boolean;
	iconClassName?: string;
	className?: string;
}) {
	return (
		<div
			data-slot="page-header-skeleton"
			aria-hidden="true"
			className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}
		>
			<div className="flex min-w-0 items-center gap-3">
				{icon ? <Skeleton className={cn("size-10 shrink-0 rounded-lg", iconClassName)} /> : null}
				<div className="min-w-0 flex-1 space-y-2">
					<Skeleton className="h-6 w-52 max-w-full" />
					{description ? <Skeleton className="h-4 w-80 max-w-full" /> : null}
				</div>
			</div>
			{actions ? <Skeleton className="h-11 w-36 sm:h-8" /> : null}
		</div>
	);
}
