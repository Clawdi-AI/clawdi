import { settingsSectionClasses as styles } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { Separator } from "../separator";
import { WebText, WebView } from "../web-layout";
export function SettingsSection({
	title,
	description,
	children,
	destructive = false,
}: {
	title: string;
	description?: string;
	children?: ReactNode;
	destructive?: boolean;
}) {
	return (
		<WebView recipe={styles.root}>
			<Separator />
			<WebView recipe={styles.header}>
				<WebView recipe={styles.copy}>
					<WebText recipe={`${styles.title} ${destructive ? styles.destructive : ""}`}>
						{title}
					</WebText>
					{description ? <WebText recipe={styles.description}>{description}</WebText> : null}
				</WebView>
			</WebView>
			<WebView recipe={styles.content}>{children}</WebView>
		</WebView>
	);
}
