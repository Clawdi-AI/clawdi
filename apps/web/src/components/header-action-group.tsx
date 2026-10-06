import { headerActionGroupClasses } from "@clawdi/shared/ui";
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
	return <div className={cn(headerActionGroupClasses.root, className)}>{children}</div>;
}
