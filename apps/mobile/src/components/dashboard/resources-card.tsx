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
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { AppPressable } from "@/components/ui/view";
import { WebIcon, WebText, WebView, webView } from "@/components/ui/web-layout";

const icons = { projects: FolderKanban, skills: Sparkles, vaults: Key, connectors: Plug };
const routes: Record<(typeof LIBRARY_ROW_IDS)[number], Href> = {
	projects: "/projects",
	skills: "/skills",
	vaults: "/vault",
	connectors: "/connectors",
};
const tints = {
	"identity-1": identity.projects,
	"identity-2": identity.skills,
	"identity-4": identity.vaults,
	"identity-7": identity.connectors,
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
		<Card className={webView(styles.root)}>
			<CardHeader className={webView(styles.header)}>
				<CardTitle>{DASHBOARD_COPY.libraryTitle}</CardTitle>
			</CardHeader>
			<CardContent className={webView(styles.content)}>
				<WebView recipe={styles.content}>
					{statsError ? (
						<WebView recipe={styles.error}>
							<ApiErrorPanel
								error={statsError}
								onRetry={onRetryStats}
								title={DASHBOARD_COPY.libraryError}
							/>
						</WebView>
					) : stats ? (
						dashboardResources(stats).map(({ id, definition, count }, i) => (
							<WebView key={id} recipe={styles.content}>
								{i > 0 ? <Separator /> : null}
								<AppPressable
									accessibilityRole="link"
									className={webView(styles.row)}
									onPress={() => router.push(routes[id])}
								>
									<WebView recipe={`${styles.iconTile} ${tints[RESOURCE_TINT_TOKENS[id]]}`}>
										<WebIcon as={icons[id]} recipe={styles.icon} />
									</WebView>
									<WebView recipe={styles.body}>
										<WebText recipe={styles.name}>{definition.label}</WebText>
									</WebView>
									<WebText
										recipe={`${styles.count} ${count === null || count === 0 ? styles.emptyCount : styles.activeCount}`}
									>
										{count === null ? "—" : formatNumber(count)}
									</WebText>
								</AppPressable>
							</WebView>
						))
					) : (
						LIBRARY_ROW_IDS.map((id) => (
							<WebView key={id} recipe={styles.skeletonRow} className="flex-row">
								<Skeleton className={webView(styles.iconSkeleton)} />
								<Skeleton className={webView(styles.nameSkeleton)} />
								<Skeleton className={webView(styles.countSkeleton)} />
							</WebView>
						))
					)}
				</WebView>
			</CardContent>
		</Card>
	);
}
