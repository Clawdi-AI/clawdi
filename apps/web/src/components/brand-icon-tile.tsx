import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";

export type BrandIconComponent = ComponentType<
	Omit<SVGProps<SVGSVGElement>, "size"> & { size?: number | string }
>;

const BRAND_ICON_SIZE = "84%";
const BRAND_ICON_STYLE = { width: BRAND_ICON_SIZE, height: BRAND_ICON_SIZE };

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
				size={BRAND_ICON_SIZE}
				style={BRAND_ICON_STYLE}
				aria-hidden
				className={cn("shrink-0", iconClassName)}
				data-icon-source="lobehub"
			/>
		</span>
	);
}
