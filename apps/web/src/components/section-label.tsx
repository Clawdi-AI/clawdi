import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionLabel({
	children,
	count,
	leading,
	className,
}: {
	children: ReactNode;
	count?: ReactNode;
	leading?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex items-center gap-2 px-0.5", className)}>
			{leading ? <span className="shrink-0 text-sm leading-none">{leading}</span> : null}
			<span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{children}
			</span>
			{count !== undefined ? <span className="text-xs text-muted-foreground">{count}</span> : null}
		</div>
	);
}
