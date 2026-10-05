import { channelDetailPageClasses as styles } from "@clawdi/shared/ui";
import type { LucideIcon } from "lucide-react-native";
import { IconChip } from "../icon-chip";
import { WebIcon, WebText, WebView, webView } from "../web-layout";

export function ChannelInfoCard({
	icon,
	title,
	children,
}: {
	icon: LucideIcon;
	title: string;
	children: string;
}) {
	return (
		<WebView recipe={styles.notice}>
			<WebView recipe={styles.noticeHeader} className="flex-row">
				<IconChip size="sm" tint={styles.infoTint} className={webView(styles.noticeIcon)}>
					<WebIcon as={icon} recipe={styles.actionIcon} />
				</IconChip>
				<WebView recipe={styles.noticeBody}>
					<WebText recipe={styles.noticeTitle}>{title}</WebText>
					<WebText recipe={styles.noticeDescription}>{children}</WebText>
				</WebView>
			</WebView>
		</WebView>
	);
}
