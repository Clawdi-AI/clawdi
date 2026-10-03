import { useLocalSearchParams, useRouter } from "expo-router";
import {
	type CloudSession,
	SessionRow,
	useCloudSessions,
} from "../../src/features/cloud-inventory";
import { InventoryList } from "../../src/features/inventory-list";
import { routeParam, uniqueSessions } from "../../src/features/read-helpers";
import { useI18n } from "../../src/i18n";
import { LoadingScreen } from "../../src/ui/feedback";
import { NativeButton } from "../../src/ui/native-controls";
import { AppView } from "../../src/ui/primitives";

export default function SessionsRoute() {
	const t = useI18n();
	const router = useRouter();
	const params = useLocalSearchParams<{ agentId?: string | string[] }>();
	const agentId = routeParam(params.agentId);
	const sessions = useCloudSessions(agentId, !params.agentId || Boolean(agentId));
	if (params.agentId && !agentId)
		return (
			<InventoryList<CloudSession>
				items={[]}
				title={t("sessions.title")}
				description={t("sessions.filterInvalid")}
				empty={t("sessions.empty")}
				renderItem={(item) => <SessionRow session={item} />}
				refreshing={false}
				onRefresh={() => {}}
				error={false}
				onRetry={() => {}}
				header={
					<NativeButton
						label={t("sessions.clearFilter")}
						onPress={() => router.replace("/sessions")}
					/>
				}
			/>
		);
	if (sessions.isPending) return <LoadingScreen label={t("loading.sessions")} />;
	return (
		<InventoryList
			items={uniqueSessions(sessions.data?.pages ?? [])}
			title={t("sessions.title")}
			description={t(agentId ? "sessions.filter" : "sessions.description")}
			empty={t("sessions.empty")}
			header={
				<AppView className="gap-3">
					<NativeButton
						label={t("sessionShares.title")}
						onPress={() => router.push("/sessions/shared")}
					/>
					{agentId ? (
						<NativeButton
							label={t("sessions.clearFilter")}
							onPress={() => router.replace("/sessions")}
						/>
					) : null}
				</AppView>
			}
			renderItem={(session) => <SessionRow session={session} />}
			refreshing={sessions.isRefetching && !sessions.isFetchingNextPage}
			onRefresh={() => {
				if (!sessions.isFetching) void sessions.refetch();
			}}
			error={sessions.isError}
			busy={sessions.isFetching}
			onRetry={() =>
				void (sessions.isFetchNextPageError ? sessions.fetchNextPage() : sessions.refetch())
			}
			more={sessions.hasNextPage}
			onMore={() => {
				if (!sessions.isFetching) void sessions.fetchNextPage();
			}}
		/>
	);
}
