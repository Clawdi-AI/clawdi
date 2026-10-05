import { dashboardPageClasses as styles } from "@clawdi/shared/ui";
import { currentDaypart, dashboardGreeting, OVERVIEW_COPY } from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { ArrowRight, MoreHorizontal } from "lucide-react-native";
import { useCurrentUser } from "../../src/auth/auth-client";
import { useCloudSessions } from "../../src/features/cloud-inventory";
import { useI18n } from "../../src/i18n";
import {
	accountQueryKey,
	useAccountRead,
	useAccountScope,
} from "../../src/platform/account-lifecycle";
import { useMobileApi } from "../../src/providers/api-provider";
import { ApiErrorPanel } from "../../src/ui/api-error-panel";
import { Button } from "../../src/ui/button";
import { Card, CardContent } from "../../src/ui/card";
import { AgentsCard } from "../../src/ui/dashboard/agents-card";
import {
	ActivityGraphSkeleton,
	ContributionGraph,
} from "../../src/ui/dashboard/contribution-graph";
import { GlobalWalletBalance } from "../../src/ui/dashboard/global-wallet-balance";
import { ConnectAnotherCard, OnboardingCard } from "../../src/ui/dashboard/onboarding-card";
import { ResourcesCard } from "../../src/ui/dashboard/resources-card";
import { TabPage } from "../../src/ui/dashboard/tab-page";
import { ThisWeekCard } from "../../src/ui/dashboard/this-week-card";
import { useDashboardAgents } from "../../src/ui/dashboard/use-dashboard-agents";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../src/ui/dropdown-menu";
import { SessionFeed } from "../../src/ui/sessions/session-feed";
import { Skeleton } from "../../src/ui/skeleton";
import { Text } from "../../src/ui/text";
import { WebIcon, WebText, WebView, webView } from "../../src/ui/web-layout";
export default function HomeRoute() {
	const { isLoaded, user } = useCurrentUser();
	const t = useI18n();
	const { agents, inventory, hasHosted, tiles, canDeploy, hostedStatus } = useDashboardAgents();
	const sessions = useCloudSessions(undefined, true, { automated: false, page_size: 25 });
	const { cloud } = useMobileApi(),
		scope = useAccountScope(),
		read = useAccountRead();
	const stats = useQuery({
		queryKey: accountQueryKey(scope, "dashboard-stats"),
		queryFn: ({ signal }) => read((lease) => cloud.getDashboardStats(lease), signal),
		enabled: scope.isReady,
		retry: false,
		staleTime: 0,
		refetchOnMount: "always",
	});
	const statsError = stats.data ? undefined : stats.error;
	const agentsError = agents.data ? undefined : agents.error;
	const sessionsError = sessions.data ? undefined : sessions.error;
	const empty =
		!agents.isPending &&
		!agentsError &&
		!hostedStatus?.isLoading &&
		!hostedStatus?.error &&
		tiles.length === 0;
	return (
		<TabPage
			title={OVERVIEW_COPY.title}
			actions={
				<>
					<GlobalWalletBalance />
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									accessibilityLabel={t("sessionFilters.options")}
								>
									<WebIcon as={MoreHorizontal} recipe={styles.viewAll} />
								</Button>
							}
						/>
						<DropdownMenuContent>
							<DropdownMenuItem
								label={t("navigation.deployments")}
								onSelect={() => router.push("/deployments")}
							/>
							<DropdownMenuItem
								label={t("publicSession.open")}
								onSelect={() => router.push("/open-share")}
							/>
							<DropdownMenuItem
								label={t("vault.supplyTitle")}
								onSelect={() => router.push("/vault-supply")}
							/>
						</DropdownMenuContent>
					</DropdownMenu>
				</>
			}
			refreshing={
				agents.isRefetching ||
				sessions.isRefetching ||
				stats.isRefetching ||
				(hasHosted && inventory.isRefetching)
			}
			onRefresh={() => {
				if (!agents.isFetching) void agents.refetch();
				if (!sessions.isFetching) void sessions.refetch();
				if (!stats.isFetching) void stats.refetch();
				if (hasHosted && !inventory.isFetching) void inventory.refetch();
			}}
		>
			{isLoaded ? (
				<WebText recipe={styles.greeting} accessibilityRole="header">
					{dashboardGreeting(currentDaypart(), user?.fullName?.split(" ")[0] ?? user?.firstName)}
				</WebText>
			) : (
				<Skeleton className={webView(styles.greetingSkeleton)} />
			)}
			<WebView recipe={styles.grid}>
				{empty ? (
					<OnboardingCard canDeployOnClawdi={canDeploy} />
				) : (
					<AgentsCard
						agents={tiles}
						isLoading={agents.isPending}
						error={agentsError}
						onRetry={() => void agents.refetch()}
						hostedStatus={hostedStatus}
					/>
				)}
				<WebView recipe={styles.activity}>
					<WebText recipe={styles.sectionTitle}>{OVERVIEW_COPY.activity}</WebText>
					<Card>
						<CardContent>
							{statsError ? (
								<ApiErrorPanel
									error={statsError}
									onRetry={() => void stats.refetch()}
									title={OVERVIEW_COPY.activityError}
								/>
							) : stats.isPending ? (
								<ActivityGraphSkeleton />
							) : stats.data?.contribution ? (
								<ContributionGraph data={stats.data.contribution} />
							) : null}
						</CardContent>
					</Card>
				</WebView>
				<WebView recipe={styles.sidebar}>
					{tiles.length > 0 ? (
						hasHosted ? (
							<OnboardingCard variant="additional-agent" canDeployOnClawdi={canDeploy} />
						) : (
							<ConnectAnotherCard />
						)
					) : null}
					<ResourcesCard
						stats={stats.data}
						statsError={statsError}
						onRetryStats={() => void stats.refetch()}
					/>
					<ThisWeekCard
						stats={stats.data}
						error={statsError}
						onRetry={() => void stats.refetch()}
					/>
				</WebView>
				<WebView recipe={styles.recentSessions}>
					<WebView recipe={styles.recentSessionsHeader} className="flex-row">
						<WebText recipe={styles.sectionTitle}>{OVERVIEW_COPY.recentSessions}</WebText>
						<Button
							variant="ghost"
							size="sm"
							textClassName={styles.viewAll}
							style={{ flexShrink: 0 }}
							onPress={() => router.push("/sessions")}
						>
							<Text numberOfLines={1}>{OVERVIEW_COPY.viewAll}</Text>
							<WebIcon as={ArrowRight} recipe={styles.viewAll} />
						</Button>
					</WebView>
					{sessionsError ? (
						<ApiErrorPanel
							error={sessionsError}
							onRetry={() => void sessions.refetch()}
							title={OVERVIEW_COPY.recentSessionsError}
						/>
					) : (
						<SessionFeed
							sessions={sessions.data?.pages[0]?.items.slice(0, 15) ?? []}
							isLoading={sessions.isPending}
							grouped={false}
							emptyVariant="inset"
							emptyMessage={OVERVIEW_COPY.manualSessionsEmpty}
						/>
					)}
				</WebView>
			</WebView>
		</TabPage>
	);
}
