import type { DashboardStats } from "@clawdi/shared/api";
import {
	resourceIdentityClasses as identity,
	resourcesCardClasses as styles,
} from "@clawdi/shared/ui";
import {
	DASHBOARD_COPY,
	dashboardResources,
	formatNumber,
	LIBRARY_ROW_IDS,
	RESOURCE_TINT_TOKENS,
} from "@clawdi/shared/view";
import { type Href, router } from "expo-router";
import { FolderKanban, Key, Plug, Sparkles } from "lucide-react-native";
import { ApiErrorPanel } from "../api-error-panel";
import { Card, CardContent, CardHeader, CardTitle } from "../card";
import { Separator } from "../separator";
import { Skeleton } from "../skeleton";
import { AppPressable } from "../view";
import { WebIcon, WebText, WebView, webView } from "../web-layout";

const icons = { projects: FolderKanban, skills: Sparkles, vaults: Key, connectors: Plug };
const routes: Record<(typeof LIBRARY_ROW_IDS)[number], Href> = {
	projects: "/projects",
	skills: "/skills",
	vaults: "/vault",
	connectors: "/connectors",
};
const tints = {
	"identity-1": identity.bgIdentity1BgText,
	"identity-2": identity.bgIdentity2BgText,
	"identity-4": identity.bgIdentity4BgText,
	"identity-7": identity.bgIdentity7BgText,
};
export function ResourcesCard({
	stats,
	statsError,
	onRetryStats,
}: {
	stats: DashboardStats | undefined;
	statsError?: unknown;
	onRetryStats?: () => void;
}) {
	return (
		<Card className={webView(styles.gap0Pb0)}>
			<CardHeader className={webView(styles.borderB)}>
				<CardTitle>{DASHBOARD_COPY.libraryTitle}</CardTitle>
			</CardHeader>
			<CardContent className={webView(styles.p0)}>
				<WebView recipe={styles.p0}>
					{statsError ? (
						<WebView recipe={styles.p6}>
							<ApiErrorPanel
								error={statsError}
								onRetry={onRetryStats}
								title={DASHBOARD_COPY.libraryError}
							/>
						</WebView>
					) : stats ? (
						dashboardResources(stats).map(({ id, definition, count }, i) => (
							<WebView key={id} recipe={styles.p0}>
								{i > 0 ? <Separator /> : null}
								<AppPressable
									accessibilityRole="link"
									className={webView(styles.groupFlexItemsCenterGap)}
									onPress={() => router.push(routes[id])}
								>
									<WebView recipe={`${styles.flexSize7Shrink0} ${tints[RESOURCE_TINT_TOKENS[id]]}`}>
										<WebIcon as={icons[id]} recipe={styles.size35} />
									</WebView>
									<WebView recipe={styles.minW0Flex1}>
										<WebText recipe={styles.textSmFontMedium}>{definition.label}</WebText>
									</WebView>
									<WebText
										recipe={`${styles.textSmTabularNums} ${count === null || count === 0 ? styles.textMutedForeground : styles.fontSemibold}`}
									>
										{count === null ? "—" : formatNumber(count)}
									</WebText>
								</AppPressable>
							</WebView>
						))
					) : (
						LIBRARY_ROW_IDS.map((id) => (
							<WebView key={id} recipe={styles.flexItemsCenterGap3} className="flex-row">
								<Skeleton className={webView(styles.size4)} />
								<Skeleton className={webView(styles.h4Flex1)} />
								<Skeleton className={webView(styles.h4W8)} />
							</WebView>
						))
					)}
				</WebView>
			</CardContent>
		</Card>
	);
}
