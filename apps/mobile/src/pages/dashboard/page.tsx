import { dashboardPageClasses as styles } from "@clawdi/shared/ui";
import { currentDaypart, dashboardGreeting, OVERVIEW_COPY } from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { ArrowRight, MoreHorizontal } from "lucide-react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useMobileApi } from "@/components/api-provider";
import { AgentsCard } from "@/components/dashboard/agents-card";
import {
	ActivityGraphSkeleton,
	ContributionGraph,
} from "@/components/dashboard/contribution-graph";
import { ConnectAnotherCard, OnboardingCard } from "@/components/dashboard/onboarding-card";
import { ResourcesCard } from "@/components/dashboard/resources-card";
import { TabPage } from "@/components/dashboard/tab-page";
import { ThisWeekCard } from "@/components/dashboard/this-week-card";
import { SessionFeed } from "@/components/sessions/session-feed";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { WebIcon, WebText, WebView, webView } from "@/components/ui/web-layout";
import { useCloudSessions } from "@/hooks/cloud-inventory";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { GlobalWalletBalance } from "@/hosted/global-wallet-balance";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useCurrentUser } from "@/platform/auth/auth-client";
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
