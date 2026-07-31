import { Laptop } from "lucide-react";
import type { ReactNode } from "react";
import { BrandIconTile } from "@/components/brand-icon-tile";
import { frameworkBrandIcon } from "@/components/entity-brand-icons";
import { cn } from "@/lib/utils";

function fallbackContent({
	fallback,
	label,
	fallbackIconClassName,
}: {
	fallback: "device" | "monogram";
	label: string;
	fallbackIconClassName?: string;
}): ReactNode {
	if (fallback === "monogram") return label.trim().charAt(0).toUpperCase() || "?";
	return <Laptop className={fallbackIconClassName} />;
}

/**
 * One renderer for official LobeHub framework marks. Callers provide their
 * own size/radius classes because sidebar labels and entity cards intentionally
 * use different scales, but the source map and unknown-agent fallback decision
 * stay here.
 */
export function AgentFrameworkIcon({
	agent,
	label,
	alt = "",
	pixelSize,
	boxClassName,
	fallbackIconClassName,
	fallback = "device",
	avatarUrl,
	className,
	draggable = false,
}: {
	agent: string | null | undefined;
	label?: string | null;
	alt?: string;
	pixelSize: number;
	boxClassName: string;
	fallbackIconClassName?: string;
	fallback?: "device" | "monogram";
	avatarUrl?: string | null;
	className?: string;
	draggable?: boolean;
}) {
	const customAvatar = avatarUrl?.trim();
	if (customAvatar) {
		return (
			<img
				src={customAvatar}
				alt={alt}
				width={pixelSize}
				height={pixelSize}
				draggable={draggable}
				className={cn(boxClassName, "shrink-0 bg-muted object-cover", className)}
			/>
		);
	}

	const brand = frameworkBrandIcon(agent);
	if (brand) {
		return (
			<BrandIconTile
				icon={brand.icon}
				iconClassName={brand.iconClassName}
				iconScale={brand.iconScale}
				label={alt || brand.label}
				boxClassName={boxClassName}
				className={cn(brand.tileClassName, className)}
			/>
		);
	}

	return (
		<div
			className={cn(
				boxClassName,
				"flex shrink-0 items-center justify-center bg-muted font-semibold text-muted-foreground",
				className,
			)}
		>
			{fallbackContent({
				fallback,
				label: label ?? agent ?? "",
				fallbackIconClassName,
			})}
		</div>
	);
}
