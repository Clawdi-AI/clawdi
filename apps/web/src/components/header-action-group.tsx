import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Responsive action group shared by page and section headers. */
export function HeaderActionGroup({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex w-full min-w-0 flex-wrap items-center gap-2 max-sm:[&_button]:min-h-11 max-sm:[&_[data-slot=button]]:min-h-11 sm:w-auto sm:shrink-0 sm:justify-end",
				className,
			)}
		>
			{children}
		</div>
	);
}
