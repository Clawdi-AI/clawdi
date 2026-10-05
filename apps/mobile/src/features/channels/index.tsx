import type { ChannelAccount } from "@clawdi/shared/api";
import { useRouter } from "expo-router";
import { useI18n } from "../../i18n";
import { useAccountScope } from "../../platform/account-lifecycle";
import { NativeButton } from "../../ui/native-controls";
import { AppText, AppView } from "../../ui/primitives";
import { InventoryList } from "../inventory-list";
import { ChannelCreate } from "./create";
import { useChannelQuery } from "./queries";

export function ChannelsScreen() {
	const scope = useAccountScope();
	return <ChannelsView key={`${scope.accountKey}:${scope.generation}`} />;
}

function ChannelsView() {
	const t = useI18n();
	const router = useRouter();
	const pool = useChannelQuery(["pool"], (api, signal) => api.pool(signal));
	const owned = useChannelQuery(["owned"], (api, signal) => api.list(signal));
	const health = useChannelQuery(["health"], (api, signal) => api.health(signal));
	const refresh = () => {
		void pool.refetch();
		void owned.refetch();
		void health.refetch();
	};
	const items = [
		...new Map<string, ChannelAccount>(
			[...(owned.data ?? []), ...Object.values(pool.data?.providers ?? {}).flat()].map((bot) => [
				bot.id,
				bot,
			]),
		).values(),
	];
	return (
		<InventoryList
			header={
				<AppView className="gap-3">
					<NativeButton
						label={t("whatsapp.title")}
						onPress={() => router.push("/channels/whatsapp")}
					/>
					<ChannelCreate
						refresh={async () => {
							const results = await Promise.all([pool.refetch(), owned.refetch()]);
							if (results.some((result) => result.isError))
								throw new Error("Channel inventory unavailable");
						}}
					/>
				</AppView>
			}
			title={t("channels.title")}
			description={t("channels.description")}
			empty={t(pool.isPending || owned.isPending ? "loading.app" : "channels.empty")}
			items={items}
			refreshing={pool.isRefetching || health.isRefetching}
			onRefresh={refresh}
			error={pool.isError || health.isError || owned.isError}
			onRetry={refresh}
			busy={pool.isFetching || health.isFetching}
			renderItem={(bot) => {
				const status = health.data?.items.find((item) => item.account_id === bot.id)?.health_status;
				return (
					<AppView className="gap-3 rounded-2xl bg-card p-4">
						<AppText className="text-lg font-semibold text-foreground">{bot.name}</AppText>
						<AppText className="text-muted-foreground">
							{bot.provider} ·{" "}
							{t(bot.visibility === "private" ? "channels.custom" : "channels.shared")} ·{" "}
							{bot.status}
						</AppText>
						<AppText>
							{t("channels.health")}: {t(status ? `channels.${status}` : "channels.unknown")}
						</AppText>
						<NativeButton
							label={t("channels.details")}
							onPress={() => router.push(`/channels/${encodeURIComponent(bot.id)}`)}
						/>
					</AppView>
				);
			}}
		/>
	);
}
