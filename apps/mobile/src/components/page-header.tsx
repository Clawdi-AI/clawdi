import { pageHeaderClasses as styles } from "@clawdi/shared/ui";
import { cn } from "cn";
import type { ReactNode } from "react";
import { HeaderActionGroup } from "@/components/header-action-group";
import { Skeleton } from "@/components/ui/skeleton";
import { WebContent, WebText, WebView, webText, webView } from "@/components/ui/web-layout";

interface PageHeaderProps {
	title: ReactNode;
	titleAdornment?: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	icon?: ReactNode;
	status?: ReactNode;
	className?: string;
	"data-slot"?: string;
	"aria-hidden"?: boolean;
}
export function PageHeader({
	title,
	titleAdornment,
	description,
	actions,
	icon,
	status,
	className,
	"aria-hidden": hidden,
}: PageHeaderProps) {
	return (
		<WebView
			recipe={styles.root}
			accessibilityElementsHidden={hidden}
			importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
			className={className}
		>
			<WebView recipe={styles.lockup} className="w-full">
				{icon ? <WebView recipe={styles.icon}>{icon}</WebView> : null}
				<WebView recipe={styles.body} style={{ flex: 1, minWidth: 0 }}>
					<WebView recipe={styles.titleRow}>
						{typeof title === "string" || typeof title === "number" ? (
							<WebText recipe={styles.title} accessibilityRole="header">
								{title}
							</WebText>
						) : (
							title
						)}
						{titleAdornment}
					</WebView>
					{description ? (
						<WebView recipe={styles.description}>
							<WebContent recipe={webText(styles.description)}>{description}</WebContent>
						</WebView>
					) : null}
					{status ? <WebView recipe={styles.status}>{status}</WebView> : null}
				</WebView>
			</WebView>
			{actions ? <HeaderActionGroup>{actions}</HeaderActionGroup> : null}
		</WebView>
	);
}
/** `h-lh` uses the title/body line heights in native layout. */
export function PageHeaderSkeleton({
	icon = false,
	actions = false,
	description = true,
	iconClassName,
	className,
}: {
	icon?: boolean;
	actions?: boolean;
	description?: boolean | string;
	iconClassName?: string;
	className?: string;
}) {
	return (
		<PageHeader
			aria-hidden
			className={className}
			icon={icon ? <Skeleton className={cn(webView(styles.skeletonIcon), iconClassName)} /> : null}
			title={<Skeleton className={cn(webView(styles.skeletonTitle), "h-7")} />}
			description={
				description ? <Skeleton className={cn(webView(styles.skeletonDescription), "h-5")} /> : null
			}
			actions={actions ? <Skeleton className={webView(styles.skeletonActions)} /> : null}
		/>
	);
}
