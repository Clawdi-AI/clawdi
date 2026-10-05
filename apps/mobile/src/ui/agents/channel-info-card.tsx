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
		<WebView recipe={styles.roundedLgBorderBgCardP}>
			<WebView recipe={styles.flexItemsStartGap} className="flex-row">
				<IconChip size="sm" tint={styles.infoTint} className={webView(styles.sizeSvgSize)}>
					<WebIcon as={icon} recipe={styles.size} />
				</IconChip>
				<WebView recipe={styles.minWFlexSpaceY}>
					<WebText recipe={styles.textSmFontMedium}>{title}</WebText>
					<WebText recipe={styles.textSmTextMutedForeground}>{children}</WebText>
				</WebView>
			</WebView>
		</WebView>
	);
}
