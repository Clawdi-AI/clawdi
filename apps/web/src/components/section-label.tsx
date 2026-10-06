import { sectionLabelClasses } from "@clawdi/shared/ui";
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
		<div className={cn(sectionLabelClasses.root, className)}>
			{leading ? <span className={sectionLabelClasses.leading}>{leading}</span> : null}
			<span className={sectionLabelClasses.label}>{children}</span>
			{count !== undefined ? <span className={sectionLabelClasses.count}>{count}</span> : null}
		</div>
	);
}
