import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const ICON_CHIP_SIZE_CLASS = {
	xs: "size-5 rounded-md [&>svg]:size-3.5",
	sm: "size-8 rounded-md [&>svg]:size-4",
	md: "size-10 rounded-lg [&>svg]:size-5",
	lg: "size-12 rounded-xl [&>svg]:size-6",
} as const;

export type IconChipSize = keyof typeof ICON_CHIP_SIZE_CLASS;

/**
 * Tinted tile for symbolic UI glyphs: Lucide icons, compact emoji/object marks,
 * and resource identity chips. Use `EntityIcon` when the tile is a real brand,
 * app, provider, channel, or framework image.
 */
export function IconChip({
	size = "md",
	tint = "bg-muted text-muted-foreground",
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
			className={cn(
				"flex shrink-0 select-none items-center justify-center leading-none",
				ICON_CHIP_SIZE_CLASS[size],
				tint,
				className,
			)}
		>
			{children}
		</span>
	);
}
