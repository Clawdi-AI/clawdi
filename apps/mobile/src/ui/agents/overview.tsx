import {
	agentOverviewLayoutClasses as layout,
	agentOverviewCapabilitiesClasses as styles,
} from "@clawdi/shared/ui";
import type { LucideIcon } from "lucide-react-native";
import { ArrowRight } from "lucide-react-native";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../card";
import { IconChip } from "../icon-chip";
import { AppPressable } from "../view";
import { WebIcon, WebText, WebView, webView } from "../web-layout";
export function AgentOverviewHeading({
	children,
	action,
}: {
	children: string;
	action?: ReactNode;
}) {
	return (
		<WebView recipe={layout.heading} className="flex-row">
			<WebText recipe={styles.sectionTitle}>{children}</WebText>
			{action}
		</WebView>
	);
}
export function OverviewNavigationCard({
	title,
	description,
	icon,
	tint,
	onPress,
	children,
}: {
	title: string;
	description: ReactNode;
	icon: LucideIcon;
	tint: string;
	onPress?: () => void;
	children?: ReactNode;
}) {
	return (
		<Card
			size="sm"
			className={webView((children ? styles.module : styles.statusCard).replace(/\bh-full\b/g, ""))}
		>
			<CardHeader
				className={webView(
					(children ? styles.header : styles.statusHeader).replace(/\bh-full\b/g, ""),
				)}
			>
				<AppPressable
					accessibilityRole="link"
					accessibilityLabel={title}
					onPress={onPress}
					disabled={!onPress}
					className={`${webView(children ? styles.headingLink : styles.statusLink)} flex-row`}
				>
					<IconChip size="sm" tint={tint}>
						<WebIcon as={icon} recipe={styles.arrowSkeleton} />
					</IconChip>
					<WebView recipe={styles.headingBody}>
						<CardTitle>{title}</CardTitle>
						<CardDescription>{description}</CardDescription>
					</WebView>
					{onPress ? <WebIcon as={ArrowRight} recipe={styles.arrow} /> : null}
				</AppPressable>
			</CardHeader>
			{children ? <CardContent className={webView(styles.content)}>{children}</CardContent> : null}
		</Card>
	);
}
export function OverviewMetadata({ items }: { items: { label: string; value: ReactNode }[] }) {
	return (
		<WebView recipe={styles.metadata}>
			{items.map((item) => (
				<WebView key={item.label} recipe={styles.metadataRow} className="flex-row">
					<WebText recipe={styles.metadata}>{item.label}</WebText>
					<WebText
						recipe={`${styles.metadata} ${styles.metadataValue}`}
						className="flex-shrink"
						style={{ flex: 1 }}
					>
						{item.value}
					</WebText>
				</WebView>
			))}
		</WebView>
	);
}
