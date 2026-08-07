import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Single-line truncation that keeps the full text one hover away. Use this
 * for user-meaningful strings (names, titles, descriptions) that can clip;
 * purely decorative or static labels can keep a bare `truncate` class.
 */
export function TruncatedText({
	children,
	className,
	title,
	...props
}: Omit<React.ComponentProps<"span">, "title"> & {
	children: ReactNode;
	title?: string;
}) {
	const resolvedTitle =
		title ??
		(typeof children === "string" || typeof children === "number" ? String(children) : undefined);
	return (
		<span {...props} className={cn("truncate", className)} title={resolvedTitle}>
			{children}
		</span>
	);
}
