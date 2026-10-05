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
import { useAccountScope } from "../../platform/account-lifecycle";
import { ChannelCard } from "../../ui/agents/channel-card";
import { ActionButton } from "../../ui/agents/controls";
import { AgentSectionNavigation } from "../../ui/agents/navigation";
import { ApiErrorPanel } from "../../ui/api-error-panel";
import { Button } from "../../ui/button";
import { EmptyState } from "../../ui/empty-state";
import { EntityCardSkeleton } from "../../ui/entity-card";
import { FilterChip } from "../../ui/filter-chip";
import { Icon } from "../../ui/icon";
import { ListToolbar } from "../../ui/list-toolbar";
import { PageHeader } from "../../ui/page-header";
import { AppScrollView } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { SectionLabel } from "../../ui/section-label";
import { Text } from "../../ui/text";
import { WebText, WebView, webView } from "../../ui/web-layout";
import { useCloudAgent } from "../cloud-inventory";
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
	const refresh = async () => {
		const results = await Promise.all([pool.refetch(), owned.refetch(), linked.refetch()]);
		if (results.some((r) => r.isError)) throw new Error("Channel inventory unavailable");
	};
	if (agentId && groups)
		return (
			<ReadScreen>
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
									{kind === "custom" ? <ChannelCreate refresh={refresh} scoped /> : null}
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
												<ChannelCard
													key={bot.id}
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
			</ReadScreen>
		);
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
					<WebView recipe={styles.ownedSection}>
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
													<>
														<Button
															variant="outline"
															size="sm"
															onPress={() =>
																router.push({ pathname: "/channels/[id]", params: { id: bot.id } })
															}
														>
															<Icon as={Link2} />
															<Text>Link Agent</Text>
														</Button>
														<Button
															variant="ghost"
															size="icon-sm"
															accessibilityLabel="Delete channel"
															onPress={() =>
																router.push({ pathname: "/channels/[id]", params: { id: bot.id } })
															}
														>
															<Icon as={Trash2} />
														</Button>
													</>
												}
											/>
										))}
							</WebView>
						)}
					</WebView>
				) : null}
				{bots.length || pool.isPending || pool.isError ? (
					<WebView recipe={styles.sharedSection}>
						<WebView recipe={styles.ownedSection}>
							<SectionLabel count={!pool.isPending ? bots.length : undefined}>
								{agentSurfaceCopy.clawdiBots}
							</SectionLabel>
							<WebText recipe={styles.sharedDescription}>
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
