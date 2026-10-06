import { brandIconTileClasses } from "@clawdi/shared/ui";
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
			className={cn(boxClassName, brandIconTileClasses.root, className)}
		>
			<Icon
				size={iconSize}
				style={{ width: iconSize, height: iconSize }}
				aria-hidden
				className={cn(brandIconTileClasses.mark, iconClassName)}
				data-icon-source="lobehub"
			/>
		</span>
	);
}
