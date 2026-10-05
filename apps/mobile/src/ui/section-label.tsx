import { sectionLabelClasses as styles } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { WebContent, WebView } from "./web-layout";
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
		<WebView recipe={styles.root} className={className}>
			{leading ? (
				<WebView recipe={styles.leading}>
					<WebContent recipe={styles.leading}>{leading}</WebContent>
				</WebView>
			) : null}
			<WebContent recipe={styles.label}>{children}</WebContent>
			{count !== undefined ? <WebContent recipe={styles.count}>{count}</WebContent> : null}
		</WebView>
	);
}
