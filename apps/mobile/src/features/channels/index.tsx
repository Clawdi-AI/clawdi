import {
	agentsIndexClasses,
	ENTITY_GRID_CLASS,
	channelsPageClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	buildAgentChannelCardGroups,
	type ChannelProviderFilter,
	canonicalAgentChannelLinks,
	channelHealthSummary,
	orderedChannelsForFilter,
	providerCounts,
	providerMeta,
	providersWithBots,
	sharedBotsFromPool,
} from "@clawdi/shared/view";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { useAccountScope } from "../../platform/account-lifecycle";
import { ChannelCard } from "../../ui/agents/channel-card";
import { ActionButton } from "../../ui/agents/controls";
import { AgentSectionNavigation } from "../../ui/agents/navigation";
import { ApiErrorPanel } from "../../ui/api-error-panel";
import { EmptyState } from "../../ui/empty-state";
import { EntityCardSkeleton } from "../../ui/entity-card";
import { FilterChip } from "../../ui/filter-chip";
import { ListToolbar } from "../../ui/list-toolbar";
import { PageHeader } from "../../ui/page-header";
import { AppScrollView } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { SectionLabel } from "../../ui/section-label";
import { Text } from "../../ui/text";
import { WebText, WebView, webView } from "../../ui/web-layout";
import { routeParam } from "../read-helpers";
import { ChannelCreate } from "./create";
import { useChannelQuery } from "./queries";
export function ChannelsScreen() {
	const scope = useAccountScope();
	return <ChannelsView key={`${scope.accountKey}:${scope.generation}`} />;
}
function ChannelsView() {
	const params = useLocalSearchParams<{ agentId?: string | string[] }>(),
		agentId = routeParam(params.agentId);
	const linked = useChannelQuery(
		["agent", agentId ?? "missing"],
		(api, signal) => api.agentLinks(agentId ?? "", signal),
		Boolean(agentId),
	);
	const router = useRouter(),
		[filter, setFilter] = useState<ChannelProviderFilter>("all");
	const pool = useChannelQuery(["pool"], (api, signal) => api.pool(signal));
	const owned = useChannelQuery(["owned"], (api, signal) => api.list(signal));
	const health = useChannelQuery(["health"], (api, signal) => api.health(signal));
	const shared = sharedBotsFromPool(pool.data?.providers);
	const counts = providerCounts([...(owned.data ?? []), ...shared]);
	const groups = agentId
		? buildAgentChannelCardGroups({
				channels: owned.data ?? [],
				poolProviders: pool.data?.providers,
				links: canonicalAgentChannelLinks({ links: linked.data ?? [], agentId }),
			})
		: null;
	const total = (owned.data?.length ?? 0) + shared.length;
	const custom = orderedChannelsForFilter(owned.data ?? [], filter),
		bots = orderedChannelsForFilter(shared, filter);
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName={webView(agentsIndexClasses.page)}>
				{agentId ? <AgentSectionNavigation agentId={agentId} section="channels" /> : null}
				<PageHeader
					title={agentSurfaceCopy.channels}
					description={
						agentId
							? "Channels linked to this agent."
							: agentSurfaceCopy.manageCustomBotsAndDiscoverClawdiBotsForYour
					}
					actions={
						<ChannelCreate
							refresh={async () => {
								const results = await Promise.all([pool.refetch(), owned.refetch()]);
								if (results.some((result) => result.isError))
									throw new Error("Channel inventory unavailable");
							}}
						/>
					}
				/>
				<ListToolbar
					filters={
						<>
							<FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
								<Text>All {total}</Text>
							</FilterChip>
							{providersWithBots(counts).map((provider) => (
								<FilterChip
									key={provider}
									active={filter === provider}
									onClick={() => setFilter(provider)}
								>
									<Text>
										{providerMeta(provider).label} {counts[provider]}
									</Text>
								</FilterChip>
							))}
						</>
					}
				/>
				{!total && !owned.isPending && !pool.isPending && !owned.isError && !pool.isError ? (
					<EmptyState
						title={agentSurfaceCopy.noBotsYet}
						description={agentSurfaceCopy.addACustomTelegramDiscordOrWhatsapp}
					/>
				) : null}
				{custom.length || owned.isPending || owned.isError ? (
					<WebView recipe={styles.flexFlexColGap}>
						<SectionLabel count={!owned.isPending ? custom.length : undefined}>
							{agentSurfaceCopy.customBots}
						</SectionLabel>
						{health.isError ? (
							<ApiErrorPanel
								error={health.error}
								title={agentSurfaceCopy.couldnTLoadChannelHealth}
								onRetry={() => void health.refetch()}
							/>
						) : null}
						{owned.isError && !owned.data ? (
							<ApiErrorPanel
								error={owned.error}
								title={agentSurfaceCopy.couldnTLoadChannels}
								onRetry={() => void owned.refetch()}
							/>
						) : (
							<WebView recipe={ENTITY_GRID_CLASS}>
								{owned.isPending
									? [0, 1, 2].map((i) => <EntityCardSkeleton key={i} trailingBadge />)
									: custom.map((bot) => (
											<ChannelCard
												key={bot.id}
												provider={bot.provider}
												title={bot.name}
												state={[
													...(bot.status !== "active" ? [bot.status] : []),
													...(health.data?.items
														.filter(
															(item) => item.account_id === bot.id && item.health_status !== "ok",
														)
														.map((item) => channelHealthSummary(item).label) ?? []),
												]}
												actions={
													<ActionButton
														label={
															groups &&
															[...groups.customBots, ...groups.clawdiBots].some(
																(item) => item.id === bot.id && item.link,
															)
																? "Paired chats"
																: "Link Agent"
														}
														onPress={() =>
															router.push({
																pathname: "/channels/[id]",
																params: { id: bot.id, ...(agentId ? { agentId } : {}) },
															})
														}
													/>
												}
											/>
										))}
							</WebView>
						)}
					</WebView>
				) : null}
				{bots.length || pool.isPending || pool.isError ? (
					<WebView recipe={styles.flexMinWFlex}>
						<WebView recipe={styles.flexFlexColGap}>
							<SectionLabel count={!pool.isPending ? bots.length : undefined}>
								{agentSurfaceCopy.clawdiBots}
							</SectionLabel>
							<WebText recipe={styles.mtTextXsText}>
								{agentSurfaceCopy.linkAnAgentAndPairAChatWithoutLeaving}
							</WebText>
						</WebView>
						{pool.isError && !pool.data ? (
							<ApiErrorPanel
								error={pool.error}
								title={agentSurfaceCopy.couldnTLoadClawdiBots}
								onRetry={() => void pool.refetch()}
							/>
						) : (
							<WebView recipe={ENTITY_GRID_CLASS}>
								{pool.isPending ? (
									<EntityCardSkeleton trailingBadge />
								) : (
									bots.map((bot) => (
										<ChannelCard
											key={bot.id}
											provider={bot.provider}
											title={bot.name}
											actions={
												<ActionButton
													label={
														groups &&
														[...groups.customBots, ...groups.clawdiBots].some(
															(item) => item.id === bot.id && item.link,
														)
															? "Paired chats"
															: "Link Agent"
													}
													disabled={
														!bot.available ||
														!bot.capabilities.link_agent ||
														(bot.max_links != null && bot.link_count >= bot.max_links)
													}
													onPress={() =>
														router.push({
															pathname: "/channels/[id]",
															params: { id: bot.id, ...(agentId ? { agentId } : {}) },
														})
													}
												/>
											}
										/>
									))
								)}
							</WebView>
						)}
					</WebView>
				) : null}
				<ActionButton
					label="WhatsApp"
					variant="ghost"
					onPress={() => router.push("/channels/whatsapp")}
				/>
			</AppScrollView>
		</ReadScreen>
	);
}
