import { ICON_CHIP_SIZE_CLASS, type IconChipSize } from "@clawdi/shared/ui";

export type { IconChipSize } from "@clawdi/shared/ui";

import { iconChipClasses } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Tinted tile for symbolic UI glyphs: Lucide icons, compact emoji/object marks,
 * and resource identity chips. Use `EntityIcon` when the tile is a real brand,
 * app, provider, channel, or framework image.
 */
export function IconChip({
	size = "md",
	tint = iconChipClasses.defaultTint,
	className,
	children,
	"aria-hidden": ariaHidden = true,
}: {
	size?: IconChipSize;
	tint?: string;
	className?: string;
	children: ReactNode;
	"aria-hidden"?: boolean;
}) {
	return (
		<span
			aria-hidden={ariaHidden}
			className={cn(iconChipClasses.root, ICON_CHIP_SIZE_CLASS[size], tint, className)}
		>
			{children}
		</span>
	);
}
