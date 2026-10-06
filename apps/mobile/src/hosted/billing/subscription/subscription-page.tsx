import { billingPageClass } from "@clawdi/shared/ui";
import { useRouter } from "expo-router";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { ClerkAction as DetailAction } from "@/components/auth/clerk-form";
import { EmptyState } from "@/components/empty-state";
import { ResourceError } from "@/components/resource-error";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { Text } from "@/components/ui/text";
import { AppScrollView, AppView } from "@/components/ui/view";
import { webView } from "@/components/ui/web-layout";
import { validSubscriptionId } from "@/hosted/billing/format";
import { useSubscriptions } from "@/hosted/billing/hooks";
import { SubscriptionDetails } from "@/hosted/billing/subscription/subscription-details";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
export function SubscriptionDetailScreen({
	subscriptionId,
}: {
	subscriptionId: string | undefined;
}) {
	const t = useI18n();
	const router = useRouter();
	const scope = useAccountScope();
	const action = useAuthAction(scope);
	const { hosted } = useMobileApi();
	const read = useAccountRead();
	const { compute } = useMobileApi();
	const validId = validSubscriptionId(subscriptionId);
	const query = useSubscriptions(validId);
	const item = query.data?.pages
		.flatMap((page) => page.items ?? [])
		.find((candidate) => candidate.subscription_id === subscriptionId);
	if (!compute)
		return (
			<SafeAreaScreen>
				<AppView className={webView(billingPageClass)}>
					<SettingsPanelHeader title={t("billing.details")} />
					<EmptyState variant="inset" title={t("billing.unavailable")} />
				</AppView>
			</SafeAreaScreen>
		);
	if (!validId)
		return (
			<SafeAreaScreen>
				<AppView className="gap-4 p-6">
					<ResourceError missing />
				</AppView>
			</SafeAreaScreen>
		);
	if (query.isPending)
		return (
			<SafeAreaScreen>
				<RouteLoadingSkeleton />
			</SafeAreaScreen>
		);
	return (
		<SafeAreaScreen>
			<AppScrollView contentContainerClassName={webView(billingPageClass)}>
				<SettingsPanelHeader title={t("billing.details")} />
				<DetailAction
					disabled={query.isFetching}
					label={t("inventory.refresh")}
					onPress={() => {
						void query.refetch();
					}}
				/>
				{query.isError ? (
					<ApiErrorPanel
						error={query.error}
						onRetry={query.isFetching ? undefined : () => void query.refetch()}
					/>
				) : null}
				{action.error ? <ApiErrorPanel error={action.error} /> : null}
				{item ? (
					<SubscriptionDetails
						item={item}
						onDeployment={() => {
							void action.run(async (owns) => {
								if (!hosted || !item.deployment_id) throw new Error("Agent unavailable");
								const deployment = await read((lease) =>
									hosted.getDeployment(item.deployment_id ?? "", lease),
								);
								if (owns() && scope.isCurrent() && !scope.signal.aborted && deployment.agent_id)
									router.push(`/agents/${encodeURIComponent(deployment.agent_id)}`);
							});
						}}
					/>
				) : !query.isError ? (
					query.hasNextPage ? (
						<>
							<Text>{t("billing.moreToSearch")}</Text>
							<DetailAction
								disabled={query.isFetching}
								label={t("inventory.loadMore")}
								onPress={() => {
									void query.fetchNextPage();
								}}
							/>
						</>
					) : (
						<ResourceError missing />
					)
				) : null}
			</AppScrollView>
		</SafeAreaScreen>
	);
}
