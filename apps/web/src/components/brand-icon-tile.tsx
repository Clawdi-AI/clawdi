import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";

export type BrandIconComponent = ComponentType<
	Omit<SVGProps<SVGSVGElement>, "size"> & { size?: number | string }
>;

const DEFAULT_BRAND_ICON_SCALE = 0.84;

export function BrandIconTile({
	icon: Icon,
	label,
	boxClassName,
	iconClassName,
	iconScale = DEFAULT_BRAND_ICON_SCALE,
	className,
}: {
	icon: BrandIconComponent;
	label: string;
	boxClassName: string;
	iconClassName?: string;
	iconScale?: number;
	className?: string;
}) {
	const iconSize = `${iconScale * 100}%`;
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
				size={iconSize}
				style={{ width: iconSize, height: iconSize }}
				aria-hidden
				className={cn("shrink-0", iconClassName)}
				data-icon-source="lobehub"
			/>
		</span>
	);
}
