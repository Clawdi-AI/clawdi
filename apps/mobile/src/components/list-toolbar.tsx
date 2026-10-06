import { listToolbarClasses as styles } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { WebView } from "@/components/ui/web-layout";
export function ListToolbar({
	search,
	filters,
	actions,
	className,
}: {
	search?: ReactNode;
	filters?: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<WebView recipe={styles.root} className={className}>
			{search ? <WebView recipe={styles.search}>{search}</WebView> : null}
			{filters ? <WebView recipe={styles.filters}>{filters}</WebView> : null}
			{actions ? <WebView recipe={styles.actions}>{actions}</WebView> : null}
		</WebView>
	);
}
