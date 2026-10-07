import { pageHeaderClasses as styles } from "@clawdi/shared/ui";
import { cn } from "cn";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { WebContent, WebView, webText, webView } from "@/components/ui/web-layout";
import { NativeHeader } from "@/platform/navigation/native-header";
import type { HeaderAction, HeaderMenu } from "@/platform/navigation/native-header-types";

interface PageHeaderProps {
	testID?: string;
	title: ReactNode;
	titleAdornment?: ReactNode;
	description?: ReactNode;
	headerActions?: HeaderAction[];
	headerMenu?: HeaderMenu;
	icon?: ReactNode;
	status?: ReactNode;
	className?: string;
	"data-slot"?: string;
	"aria-hidden"?: boolean;
}
export function PageHeader({
	testID,
	title,
	titleAdornment,
	description,
	headerActions,
	headerMenu,
	icon,
	status,
	className,
	"aria-hidden": hidden,
}: PageHeaderProps) {
	return (
		<WebView
			testID={testID}
			recipe={styles.root}
			accessibilityElementsHidden={hidden}
			importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
			className={className}
		>
			<WebView recipe={styles.lockup} className="w-full">
				{icon ? <WebView recipe={styles.icon}>{icon}</WebView> : null}
				<WebView recipe={styles.body} style={{ flex: 1, minWidth: 0 }}>
					{titleAdornment}
					{description ? (
						<WebView recipe={styles.description}>
							<WebContent recipe={webText(styles.description)}>{description}</WebContent>
						</WebView>
					) : null}
					{status ? <WebView recipe={styles.status}>{status}</WebView> : null}
				</WebView>
			</WebView>
			{!hidden && typeof title === "string" ? (
				<NativeHeader title={title} actions={headerActions} menu={headerMenu} />
			) : null}
		</WebView>
	);
}
/** `h-lh` uses the title/body line heights in native layout. */
export function PageHeaderSkeleton({
	icon = false,
	description = true,
	iconClassName,
	className,
}: {
	icon?: boolean;
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
		/>
	);
}
