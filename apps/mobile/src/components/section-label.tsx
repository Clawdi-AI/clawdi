import { sectionLabelClasses as styles } from "@clawdi/shared/ui";
import { cn } from "cn";
import type { ReactNode } from "react";
import { WebContent, WebText, WebView } from "@/components/ui/web-layout";
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
		// Wrap instead of running off the row when large text no longer fits one line.
		<WebView recipe={styles.root} className={cn("flex-wrap", className)}>
			{leading ? (
				<WebView recipe={styles.leading}>
					<WebContent recipe={styles.leading}>{leading}</WebContent>
				</WebView>
			) : null}
			{typeof children === "string" || typeof children === "number" ? (
				<WebText
					recipe={styles.label}
					style={{ textTransform: "none", flexGrow: count === undefined ? 1 : 0 }}
				>
					{/* Uppercase before measurement; standalone labels use the available row width. */}
					{typeof children === "string" ? children.toUpperCase() : children}
				</WebText>
			) : (
				<WebContent recipe={styles.label}>{children}</WebContent>
			)}
			{count !== undefined ? <WebContent recipe={styles.count}>{count}</WebContent> : null}
		</WebView>
	);
}
