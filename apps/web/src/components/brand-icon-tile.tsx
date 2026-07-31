import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";

export type BrandIconComponent = ComponentType<
	Omit<SVGProps<SVGSVGElement>, "size"> & { size?: number | string }
>;

export function BrandIconTile({
	icon: Icon,
	label,
	boxClassName,
	iconClassName,
	className,
}: {
	icon: BrandIconComponent;
	label: string;
	boxClassName: string;
	iconClassName?: string;
	className?: string;
}) {
	return (
		<span
			role="img"
			aria-label={label}
			className={cn(
				boxClassName,
				"flex shrink-0 items-center justify-center border border-border/60 bg-muted/40 text-foreground shadow-none",
				className,
			)}
		>
			<Icon
				size="60%"
				aria-hidden
				className={cn("shrink-0", iconClassName)}
				data-icon-source="lobehub"
			/>
		</span>
	);
}
