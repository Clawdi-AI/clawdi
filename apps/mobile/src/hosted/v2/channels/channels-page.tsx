import {
	agentsIndexClasses,
	ENTITY_GRID_CLASS,
	agentChannelSectionClasses as scopedStyles,
	channelsPageClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentChannelLinkUnavailableReason,
	agentChannelPairedChatsLabel,
	agentSurfaceCopy,
	buildAgentChannelCardGroups,
	type ChannelProviderFilter,
	canonicalAgentChannelLinks,
	channelHealthSummary,
	orderedChannelsForFilter,
	providerCounts,
	providerMeta,
	providersWithBots,
	agentChannelSectionCopy as scopedCopy,
	sharedBotsFromPool,
} from "@clawdi/shared/view";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Link2, Link2Off, QrCode, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { EmptyState } from "@/components/empty-state";
import { EntityCardSkeleton } from "@/components/entity-card";
import { FilterChip } from "@/components/filter-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { Text } from "@/components/ui/text";
import { AppScrollView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { ChannelCard, DiscordConnectionIssueAlert } from "@/hosted/v2/channels/channel-card";
import { useChannelQuery } from "@/hosted/v2/channels/channels-hooks";
import { ChannelCreate } from "@/hosted/v2/channels/connect-bot-dialog";
import { routeParam } from "@/lib/route-params";
import { useAccountScope } from "@/platform/account-lifecycle";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
export function ChannelsScreen() {
	const scope = useAccountScope();
	return <ChannelsView key={`${scope.accountKey}:${scope.generation}`} />;
}
function ChannelsView() {
	const params = useLocalSearchParams<{ id?: string | string[]; agentId?: string | string[] }>(),
		agentId = routeParam(params.id ?? params.agentId);
	const agent = useCloudAgent(agentId);
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

	if (agentId && groups)
		return (
			<SafeAreaScreen>
				<AppScrollView contentContainerClassName={webView(agentsIndexClasses.page)}>
					<AgentSectionNavigation agentId={agentId} section="channels" />
					<PageHeader title={agentSurfaceCopy.channels} description={scopedCopy.description} />
					{(["clawdi", "custom"] as const).map((kind) => {
						const items = kind === "clawdi" ? groups.clawdiBots : groups.customBots;
						const query = kind === "clawdi" ? pool : owned;
						return (
							<WebView key={kind} recipe={scopedStyles.section}>
								<WebView recipe={scopedStyles.header} className="flex-row">
									<WebView recipe={scopedStyles.copy}>
										<SectionLabel count={items.length}>
											{kind === "clawdi"
												? agentSurfaceCopy.clawdiBots
												: agentSurfaceCopy.customBots}
										</SectionLabel>
										<WebText recipe={scopedStyles.description}>
											{kind === "clawdi"
												? scopedCopy.clawdiDescription
												: scopedCopy.customDescription}
										</WebText>
									</WebView>
									{kind === "custom" ? <ChannelCreate scoped /> : null}
								</WebView>
								{query.isError ? (
									<ApiErrorPanel error={query.error} onRetry={() => void query.refetch()} />
								) : null}
								{query.isPending ? (
									<EntityCardSkeleton trailingBadge />
								) : items.length ? (
									<WebView recipe={ENTITY_GRID_CLASS}>
										{items.map((bot) => {
											const open = () =>
												router.push({
													pathname: "/channels/[id]",
													params: { id: bot.id, agentId },
												});
											const runtime = agent.data?.agent_type;
											const issue =
												runtime === "hermes" || runtime === "openclaw"
													? agentChannelLinkUnavailableReason({
															bot,
															agentType: runtime,
															linkedProviders: linked.data
																? new Set(linked.data.map((item) => item.account.provider))
																: undefined,
														})
													: bot.available
														? null
														: "Unavailable";
											return (
												<WebView key={bot.id} recipe="flex h-full min-w-0 flex-col gap-2">
													{bot.provider === "discord" ? (
														<DiscordConnectionIssueAlert issue={bot.connection_issue} />
													) : null}
													<ChannelCard
														provider={bot.provider}
														title={bot.name}
														state={[
															bot.link ? (
																<Button
																	variant="link"
																	size="xs"
																	className={webView(scopedStyles.pairedChatsTrigger)}
																	onPress={open}
																>
																	<Text>
																		{agentChannelPairedChatsLabel(bot.link.binding_count ?? 0)}
																	</Text>
																</Button>
															) : (
																(issue ?? "Available")
															),
														]}
														actions={
															bot.link ? (
																<>
																	<Button variant="outline" size="sm" onPress={open}>
																		<Icon as={QrCode} />
																		<Text>Pair</Text>
																	</Button>
																	<Button variant="ghost" size="sm" onPress={open}>
																		<Icon as={Link2Off} />
																		<Text>Unlink</Text>
																	</Button>
																</>
															) : (
																<>
																	{bot.visibility === "private" ? (
																		<Button variant="ghost" size="sm" onPress={open}>
																			<Icon as={Trash2} />
																			<Text>Delete</Text>
																		</Button>
																	) : null}
																	<Button
																		size="sm"
																		disabled={Boolean(issue) || linked.isError || linked.isPending}
																		onPress={open}
																	>
																		<Icon as={Link2} />
																		<Text>Link</Text>
																	</Button>
																</>
															)
														}
													/>
												</WebView>
											);
										})}
									</WebView>
								) : !query.isError ? (
									<WebView recipe={scopedStyles.empty}>
										<Text>
											{kind === "clawdi" ? scopedCopy.clawdiEmpty : scopedCopy.customEmpty}
										</Text>
									</WebView>
								) : null}
							</WebView>
						);
					})}
					{linked.isError ? (
						<ApiErrorPanel error={linked.error} onRetry={() => void linked.refetch()} />
					) : null}
				</AppScrollView>
			</SafeAreaScreen>
		);
	const rows = [
		...custom.map((bot, index) => ({ kind: "custom" as const, bot, first: index === 0 })),
		...bots.map((bot, index) => ({ kind: "shared" as const, bot, first: index === 0 })),
	];
	return (
		<SafeAreaScreen>
			<NativeHeader
				title={agentSurfaceCopy.channels}
				actions={[{ id: "add", label: "Add channel", onPress: () => router.push("/channels/new") }]}
			/>
			<NativeList
				data={rows}
				keyExtractor={(row) => `${row.kind}:${row.bot.id}`}
				refreshing={owned.isRefetching || pool.isRefetching || health.isRefetching}
				onRefresh={() => {
					void owned.refetch();
					void pool.refetch();
					void health.refetch();
				}}
				header={
					<WebView recipe={styles.ownedSection}>
						<PageHeader
							title={agentSurfaceCopy.channels}
							description={agentSurfaceCopy.manageCustomBotsAndDiscoverClawdiBotsForYour}
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
						{health.isError ? (
							<ApiErrorPanel
								error={health.error}
								title={agentSurfaceCopy.couldnTLoadChannelHealth}
								onRetry={() => void health.refetch()}
							/>
						) : null}
						{owned.isError ? (
							<ApiErrorPanel
								error={owned.error}
								title={agentSurfaceCopy.couldnTLoadChannels}
								onRetry={() => void owned.refetch()}
							/>
						) : null}
						{pool.isError ? (
							<ApiErrorPanel
								error={pool.error}
								title={agentSurfaceCopy.couldnTLoadClawdiBots}
								onRetry={() => void pool.refetch()}
							/>
						) : null}
					</WebView>
				}
				empty={
					owned.isPending || pool.isPending ? (
						<EntityCardSkeleton trailingBadge />
					) : !owned.isError && !pool.isError ? (
						<EmptyState
							title={agentSurfaceCopy.noBotsYet}
							description={agentSurfaceCopy.addACustomTelegramDiscordOrWhatsapp}
						/>
					) : null
				}
				renderItem={({ item }) => (
					<WebView recipe={styles.ownedSection}>
						{item.first ? (
							<>
								<SectionLabel count={item.kind === "custom" ? custom.length : bots.length}>
									{item.kind === "custom"
										? agentSurfaceCopy.customBots
										: agentSurfaceCopy.clawdiBots}
								</SectionLabel>
								{item.kind === "shared" ? (
									<WebText recipe={styles.sharedDescription}>
										{agentSurfaceCopy.linkAnAgentAndPairAChatWithoutLeaving}
									</WebText>
								) : null}
							</>
						) : null}
						<ChannelCard
							provider={item.bot.provider}
							title={item.bot.name}
							state={
								item.kind === "custom"
									? [
											...(item.bot.status !== "active" ? [item.bot.status] : []),
											...(health.data?.items
												.filter(
													(health) =>
														health.account_id === item.bot.id && health.health_status !== "ok",
												)
												.map((health) => channelHealthSummary(health).label) ?? []),
										]
									: []
							}
							actions={
								<>
									<Button
										variant="outline"
										size="sm"
										disabled={
											item.kind === "shared" &&
											(!item.bot.available ||
												!item.bot.capabilities.link_agent ||
												(item.bot.max_links != null && item.bot.link_count >= item.bot.max_links))
										}
										onPress={() =>
											router.push({ pathname: "/channels/[id]/link", params: { id: item.bot.id } })
										}
									>
										<Icon as={Link2} />
										<Text>Link agent</Text>
									</Button>
									{item.kind === "custom" ? (
										<Button
											variant="ghost"
											size="icon-sm"
											accessibilityLabel="Delete channel"
											onPress={() =>
												router.push({
													pathname: "/channels/[id]",
													params: { id: item.bot.id, action: "delete" },
												})
											}
										>
											<Icon as={Trash2} />
										</Button>
									) : null}
								</>
							}
						/>
						{item.kind === "custom" && item.bot.provider === "discord" ? (
							<DiscordConnectionIssueAlert issue={item.bot.connection_issue} />
						) : null}
					</WebView>
				)}
			/>
		</SafeAreaScreen>
	);
}
