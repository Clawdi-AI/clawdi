import type { VariantProps } from "class-variance-authority"
import type * as React from "react";

import { cn } from "@/lib/utils";
import { statusBadgeVariants, statusDotVariants as dotVariants, statusTextVariants } from "@clawdi/shared/ui";

/* The one way to render a status chip. Maps to the semantic tokens in
 * packages/shared/src/style/theme.css — never hand-roll emerald/amber/rose
 * utilities for status colors (see DESIGN.md). */




type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>["status"]>;

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

export type { StatusTone };
export {
	dotVariants as statusDotVariants,
	StatusBadge,
	StatusDot,
	statusBadgeVariants,
	statusTextVariants,
};
