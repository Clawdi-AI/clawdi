import { pageHeaderClasses } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { HeaderActionGroup } from "@/components/header-action-group";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
	title: ReactNode;
	titleAdornment?: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	/** Left-of-title slot — e.g. a channel or runtime icon. */
	icon?: ReactNode;
	/** Meta row rendered under the title — status badges, runtime/compute, etc. */
	status?: ReactNode;
	className?: string;
	"data-slot"?: string;
	"aria-hidden"?: boolean;
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
	"data-slot": slot = "page-header",
	"aria-hidden": ariaHidden,
}: PageHeaderProps) {
	const Description = typeof description === "string" ? "p" : "div";
	return (
		<div
			data-slot={slot}
			aria-hidden={ariaHidden}
			className={cn(pageHeaderClasses.root, className)}
		>
			<div className={pageHeaderClasses.lockup}>
				{icon ? <div className={pageHeaderClasses.icon}>{icon}</div> : null}
				<div className={pageHeaderClasses.body}>
					<div className={pageHeaderClasses.titleRow}>
						<h1 className={pageHeaderClasses.title}>{title}</h1>
						{titleAdornment}
					</div>
					{description ? (
						<Description className={pageHeaderClasses.description}>{description}</Description>
					) : null}
					{status ? <div className={pageHeaderClasses.status}>{status}</div> : null}
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
	description?: boolean | string;
	iconClassName?: string;
	className?: string;
}) {
	return (
		<PageHeader
			data-slot="page-header-skeleton"
			aria-hidden
			className={className}
			icon={
				icon ? <Skeleton className={cn(pageHeaderClasses.skeletonIcon, iconClassName)} /> : null
			}
			title={<Skeleton className={pageHeaderClasses.skeletonTitle} />}
			description={
				typeof description === "string" ? (
					<Skeleton className={pageHeaderClasses.skeletonText} aria-hidden="true">
						{description}
					</Skeleton>
				) : description ? (
					<Skeleton className={pageHeaderClasses.skeletonDescription} />
				) : null
			}
			actions={actions ? <Skeleton className={pageHeaderClasses.skeletonActions} /> : null}
		/>
	);
}
