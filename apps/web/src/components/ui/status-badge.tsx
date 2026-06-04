import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/* The one way to render a status chip. Maps to the semantic tokens in
 * packages/shared/src/style/theme.css — never hand-roll emerald/amber/rose
 * utilities for status colors (see DESIGN.md). */

const statusBadgeVariants = cva(
	"inline-flex w-fit shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
	{
		variants: {
			status: {
				success: "bg-success-muted text-success-muted-foreground",
				warning: "bg-warning-muted text-warning-muted-foreground",
				destructive: "bg-destructive-muted text-destructive-muted-foreground",
				info: "bg-info-muted text-info-muted-foreground",
				neutral: "bg-muted text-muted-foreground",
			},
		},
		defaultVariants: {
			status: "neutral",
		},
	},
);

const dotVariants = cva("size-1.5 shrink-0 rounded-full", {
	variants: {
		status: {
			success: "bg-success",
			warning: "bg-warning",
			destructive: "bg-destructive",
			info: "bg-info",
			neutral: "bg-muted-foreground",
		},
	},
	defaultVariants: {
		status: "neutral",
	},
});

function StatusBadge({
	className,
	status = "neutral",
	withDot = false,
	children,
	...props
}: React.ComponentProps<"span"> &
	VariantProps<typeof statusBadgeVariants> & { withDot?: boolean }) {
	return (
		<span
			data-slot="status-badge"
			data-status={status}
			className={cn(statusBadgeVariants({ status }), className)}
			{...props}
		>
			{withDot && <span aria-hidden className={dotVariants({ status })} />}
			{children}
		</span>
	);
}

/* Standalone status dot — for tables/sidebars where a chip is too loud. */
function StatusDot({
	className,
	status = "neutral",
	...props
}: React.ComponentProps<"span"> & VariantProps<typeof dotVariants>) {
	return (
		<span
			data-slot="status-dot"
			data-status={status}
			aria-hidden
			className={cn(dotVariants({ status }), className)}
			{...props}
		/>
	);
}

export { StatusBadge, StatusDot, statusBadgeVariants };
