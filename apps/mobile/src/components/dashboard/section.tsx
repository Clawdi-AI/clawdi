import { sectionClasses as styles } from "@clawdi/shared/ui";
import { cn } from "cn";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { WebContent, WebIcon, WebText, WebView, webView } from "@/components/ui/web-layout";

type DashboardSectionPriority = "primary" | "secondary" | "quiet";
export function DashboardSection({
	children,
	priority = "secondary",
	className,
}: {
	children: ReactNode;
	priority?: DashboardSectionPriority;
	className?: string;
}) {
	return (
		<WebView
			recipe={cn(styles.root, priority === "primary" && styles.primary)}
			className={className}
		>
			{children}
		</WebView>
	);
}
export function DashboardSectionHeader({
	icon,
	title,
	count,
	description,
	actions,
	priority = "secondary",
}: {
	icon: LucideIcon;
	title: string;
	count?: ReactNode;
	description: ReactNode;
	actions?: ReactNode;
	priority?: DashboardSectionPriority;
}) {
	return (
		<WebView
			recipe={cn(
				styles.header,
				priority === "quiet" && styles.quietHeader,
				priority === "primary" && styles.primaryHeader,
			)}
		>
			<WebView recipe={styles.headerBody}>
				<WebView recipe={styles.titleRow}>
					<WebIcon as={icon} recipe={styles.icon} />
					<WebText
						recipe={styles.title}
						numberOfLines={1}
						accessibilityRole="header"
						className="flex-shrink"
					>
						{title}
					</WebText>
					{count !== undefined ? (
						<Badge variant="secondary">
							<WebContent recipe={styles.count}>{count}</WebContent>
						</Badge>
					) : null}
				</WebView>
				<WebContent recipe={styles.description}>{description}</WebContent>
			</WebView>
			{actions ? <WebView recipe={styles.actions}>{actions}</WebView> : null}
		</WebView>
	);
}
export function DashboardSectionToolbar({ children }: { children: ReactNode }) {
	return <WebView recipe={styles.toolbar}>{children}</WebView>;
}
export function DashboardEmptyLine({ title, message }: { title: string; message: ReactNode }) {
	return (
		<EmptyState
			variant="inset"
			title={title}
			description={message}
			className={webView(styles.empty)}
		/>
	);
}
