"use client";

import { channelDetailPageClasses } from "@clawdi/shared/ui";
import { agentSurfaceCopy, relativeTime } from "@clawdi/shared/view";
import { Link, useRouter } from "@tanstack/react-router";
import {
	ArrowDownLeft,
	ArrowUpRight,
	Bot,
	KeyRound,
	type LucideIcon,
	MessageSquareDashed,
	MessageSquarePlus,
	RefreshCw,
	TerminalSquare,
	Trash2,
	TriangleAlert,
	Unplug,
} from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { DetailBackLink } from "@/components/detail/back-link";
import { EmptyState } from "@/components/empty-state";
import { ENTITY_CARD_BASE, EntityHeader } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { nativeTransportSummary } from "@/hosted/v2/channels/channel-detail-page.logic";
import { channelHealthSummary } from "@/hosted/v2/channels/channel-health-summary";
import {
	ChannelPairingDialog,
	useChannelPairingFlow,
} from "@/hosted/v2/channels/channel-pairing-flow";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import type { ChannelActivityItem, ChannelAgentLink } from "@/hosted/v2/channels/channel-types";
import {
	ChannelStatusBadge,
	CopyInline,
	DeliveryBadge,
	HealthBadge,
	isNormalChannelHealth,
	isNormalChannelStatus,
} from "@/hosted/v2/channels/channel-ui";
import {
	channelActivityErrorSummary,
	channelHealthErrorSummary,
} from "@/hosted/v2/channels/channel-user-facing-errors";
import {
	useChannel,
	useChannelActivity,
	useChannelAgentLinks,
	useChannelHealth,
	useDeleteChannel,
	useEnvironments,
	useSyncCommands,
	useUnlinkChannelAgent,
} from "@/hosted/v2/channels/channels-hooks";
import { LinkChannelAgentAction } from "@/hosted/v2/channels/link-channel-agent-action";
import { agentSectionLink } from "@/lib/agent-routes";
import { isApiNotFoundError } from "@/lib/api-errors";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

const PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");
const LIST_TAB_CLASS = "mt-4 min-w-0";
const FORM_TAB_CLASS = "mt-4 min-w-0 max-w-xl";
const CHANNEL_RELATION_LIST_CLASS = "divide-y overflow-hidden rounded-lg border bg-card";
const CHANNEL_RELATION_ROW_CLASS = "flex min-h-16 items-center gap-3 px-4 py-3";

type EnvironmentList = ReturnType<typeof useEnvironments>["data"];
type Environment = NonNullable<EnvironmentList>[number];

function findEnv(envs: EnvironmentList, agentId: string): Environment | null {
	return envs?.find((e) => e.id === agentId) ?? null;
}

function AgentName({ env, meta }: { env: Environment | null; meta?: ReactNode[] }) {
	if (!env) {
		return (
			<EntityHeader
				className={channelDetailPageClasses.minWFlex}
				icon={
					<IconChip size="sm">
						<Bot />
					</IconChip>
				}
				title="Agent unavailable"
				meta={meta}
			/>
		);
	}
	return (
		<AgentLabel
			machineName={env.machine_name}
			displayName={env.display_name}
			defaultName={env.default_name}
			type={env.agent_type}
			avatarUrl={env.avatar_url}
			size="sm"
			className={channelDetailPageClasses.minWFlex}
			meta={meta}
		/>
	);
}

function InfoCard({
	icon: Icon,
	title,
	children,
}: {
	icon: LucideIcon;
	title: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className={channelDetailPageClasses.roundedLgBorderBgCardP}>
			<div className={channelDetailPageClasses.flexItemsStartGap}>
				<IconChip
					size="sm"
					tint="bg-primary/10 text-primary"
					className={channelDetailPageClasses.sizeSvgSize}
				>
					<Icon />
				</IconChip>
				<div className={channelDetailPageClasses.minWFlexSpaceY}>
					<div className={channelDetailPageClasses.textSmFontMedium}>{title}</div>
					<p className={channelDetailPageClasses.textSmTextMutedForeground}>{children}</p>
				</div>
			</div>
		</div>
	);
}

function SectionHeader({
	label,
	count,
	action,
}: {
	label: string;
	count?: number;
	action?: ReactNode;
}) {
	return (
		<div className={channelDetailPageClasses.flexFlexWrapItemsCenterJustifyBetween}>
			<SectionLabel count={count}>{label}</SectionLabel>
			{action ? <div className={channelDetailPageClasses.shrink}>{action}</div> : null}
		</div>
	);
}

export function ChannelDetailPage({ channelId: id }: { channelId: string }) {
	const channel = useChannel(id);
	const health = useChannelHealth();
	const router = useRouter();
	const del = useDeleteChannel();
	const [removing, setRemoving] = useState(false);
	const removeLockedRef = useRef(false);

	function removeChannel() {
		if (removeLockedRef.current) return;
		removeLockedRef.current = true;
		setRemoving(true);
		void (async () => {
			try {
				await del.mutateAsync({ params: { path: { account_id: id } } });
				await router.navigate({ href: "/channels" });
			} catch {
				// useDeleteChannel already surfaces the API error.
			} finally {
				removeLockedRef.current = false;
				setRemoving(false);
			}
		})();
	}

	useSetBreadcrumbTitle(channel.data?.name);

	const healthItem = useMemo(
		() => health.data?.items.find((h) => h.account_id === id),
		[health.data, id],
	);

	if (channel.isLoading) {
		return (
			<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
				<DetailBackLink href="/channels" label={agentSurfaceCopy.channels} />
				<PageHeaderSkeleton icon iconClassName="size-12 rounded-xl" actions />
				<div className={channelDetailPageClasses.flexFlexColGap}>
					<Skeleton className={channelDetailPageClasses.hWFullMaxWXlRoundedLg} />
					<Skeleton className={channelDetailPageClasses.hWFullRoundedLg} />
				</div>
			</div>
		);
	}

	if (isApiNotFoundError(channel.error) || shouldBlockQueryError(channel.error, channel.data)) {
		return (
			<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
				<DetailBackLink href="/channels" label={agentSurfaceCopy.channels} />
				<ApiErrorPanel
					error={channel.error}
					onRetry={() => channel.refetch()}
					title="Couldn't load channel"
				/>
			</div>
		);
	}

	if (!channel.data) {
		return (
			<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
				<DetailBackLink href="/channels" label={agentSurfaceCopy.channels} />
				<EmptyState
					icon={MessageSquareDashed}
					title="Channel not found"
					description="This channel may have been removed."
				/>
			</div>
		);
	}

	const ch = channel.data;
	const meta = providerMeta(ch.provider);
	const providerUnavailable = meta.unavailable === true;
	const disconnectsWhatsApp = ch.provider === "whatsapp" && ch.visibility === "private";

	return (
		<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
			<DetailBackLink href="/channels" label={agentSurfaceCopy.channels} />
			<PageHeader
				title={ch.name}
				description={meta.label}
				icon={<EntityIcon kind="channel" id={ch.provider} label={meta.label} size="lg" />}
				status={
					!isNormalChannelStatus(ch.status) ||
					(healthItem && !isNormalChannelHealth(healthItem.health_status)) ? (
						<div className={channelDetailPageClasses.flexFlexWrapItemsCenterGap}>
							{isNormalChannelStatus(ch.status) ? null : <ChannelStatusBadge status={ch.status} />}
							{healthItem && !isNormalChannelHealth(healthItem.health_status) ? (
								<HealthBadge health={healthItem} />
							) : null}
						</div>
					) : undefined
				}
				actions={
					<ConfirmAction
						title={`${disconnectsWhatsApp ? "Disconnect" : "Delete"} ${ch.name}?`}
						description={
							disconnectsWhatsApp
								? "This logs out Clawdi as a linked device and removes the Custom bot. Linked Agents will stop sending and receiving."
								: "This deletes the Custom bot, its Agent links, and its paired chats. This can't be undone."
						}
						confirmLabel={disconnectsWhatsApp ? "Disconnect and remove" : "Delete custom bot"}
						destructive
						onConfirm={removeChannel}
					>
						<Button
							variant="outline"
							className={channelDetailPageClasses.textMutedForegroundHoverTextDestructive}
							disabled={removing}
						>
							{removing ? (
								<Spinner className={channelDetailPageClasses.size} />
							) : disconnectsWhatsApp ? (
								<Unplug className={channelDetailPageClasses.size} />
							) : (
								<Trash2 className={channelDetailPageClasses.size} />
							)}
							{removing
								? disconnectsWhatsApp
									? "Disconnecting…"
									: "Deleting…"
								: disconnectsWhatsApp
									? "Disconnect"
									: "Delete"}
						</Button>
					</ConfirmAction>
				}
			/>

			{providerUnavailable ? (
				<InfoCard icon={TriangleAlert} title="Provider unavailable">
					This provider is no longer available for new native channels. Existing channel data
					remains visible, and you can delete the Custom bot.
				</InfoCard>
			) : null}
			{ch.provider === "discord" && !providerUnavailable ? (
				<InfoCard icon={TriangleAlert} title="Verify Discord credentials">
					Clawdi stores Discord credentials during setup but does not verify them with Discord. Send
					a test message and confirm its activity and status before relying on this channel. To
					replace credentials, remove the channel and reconnect it.
				</InfoCard>
			) : null}

			<section data-channel-linked-agents className={channelDetailPageClasses.flexFlexColGap2}>
				<AgentsTab
					accountId={id}
					provider={ch.provider}
					channelName={ch.name}
					canManage={!providerUnavailable}
				/>
			</section>

			<Tabs defaultValue="activity" className={channelDetailPageClasses.minW}>
				<TabsList className={channelDetailPageClasses.hAutoFlexWrapJustifyStart}>
					<TabsTrigger value="activity">{agentSurfaceCopy.activity}</TabsTrigger>
					<TabsTrigger value="health">{agentSurfaceCopy.health}</TabsTrigger>
					{providerUnavailable ? null : (
						<TabsTrigger value="commands">{agentSurfaceCopy.commands}</TabsTrigger>
					)}
				</TabsList>

				<TabsContent value="activity" className={LIST_TAB_CLASS}>
					<ActivityTab accountId={id} />
				</TabsContent>
				<TabsContent value="health" className={LIST_TAB_CLASS}>
					<HealthTab accountId={id} />
				</TabsContent>
				{providerUnavailable ? null : (
					<TabsContent value="commands" className={FORM_TAB_CLASS}>
						<CommandsTab accountId={id} provider={ch.provider} />
					</TabsContent>
				)}
			</Tabs>
		</div>
	);
}

// ── Agents ───────────────────────────────────────────────────────────────────

function AgentsTab({
	accountId,
	provider,
	channelName,
	canManage,
}: {
	accountId: string;
	provider: string;
	channelName: string;
	canManage: boolean;
}) {
	const links = useChannelAgentLinks(accountId);
	const envs = useEnvironments();
	const unlinkAgent = useUnlinkChannelAgent(accountId);
	const pairing = useChannelPairingFlow(accountId);

	if (links.isLoading || envs.isLoading) {
		return <Skeleton className={channelDetailPageClasses.hWFullRoundedLg2} />;
	}
	if (shouldBlockQueryError(links.error, links.data)) {
		return (
			<ApiErrorPanel
				error={links.error}
				onRetry={() => links.refetch()}
				title="Couldn't load linked Agents"
			/>
		);
	}
	if (shouldBlockQueryError(envs.error, envs.data)) {
		return (
			<ApiErrorPanel
				error={envs.error}
				onRetry={() => envs.refetch()}
				title="Couldn't load Agent names"
			/>
		);
	}
	const items = links.data ?? [];

	return (
		<div className={channelDetailPageClasses.flexFlexColGap2}>
			<SectionHeader
				label="Linked Agents"
				count={items.length}
				action={
					canManage ? (
						<LinkChannelAgentAction
							accountId={accountId}
							provider={provider}
							channelName={channelName}
						/>
					) : undefined
				}
			/>

			{items.length === 0 ? (
				<EmptyState
					variant="inset"
					title="No Agents linked"
					description="Link an Agent here, then pair a chat for it."
				/>
			) : (
				<div className={CHANNEL_RELATION_LIST_CLASS}>
					{items.map((link: ChannelAgentLink) => (
						<div
							key={link.id}
							data-channel-agent-link-id={link.id}
							className={CHANNEL_RELATION_ROW_CLASS}
						>
							<AgentName
								env={findEnv(envs.data, link.agent_id)}
								meta={[
									...(isNormalChannelStatus(link.status)
										? []
										: [<ChannelStatusBadge key="status" status={link.status} />]),
									<span key="linked">Linked {relativeTime(link.created_at)}</span>,
								]}
							/>
							<div className={channelDetailPageClasses.flexShrinkItemsCenterGap}>
								{canManage ? (
									<Button
										size="sm"
										variant="outline"
										disabled={pairing.openingLinkId !== null}
										onClick={() => void pairing.openPairing(link)}
									>
										{pairing.openingLinkId === link.id ? (
											<Spinner className={channelDetailPageClasses.size2} />
										) : (
											<MessageSquarePlus className={channelDetailPageClasses.size2} />
										)}
										Pair chat
									</Button>
								) : null}
								<Button
									render={<Link {...agentSectionLink(link.agent_id, "channels")} />}
									nativeButton={false}
									variant="ghost"
									size="icon-sm"
									aria-label="Open Agent Channels"
								>
									<ArrowUpRight className={channelDetailPageClasses.size2} />
								</Button>
								{canManage ? (
									<ConfirmAction
										title="Unlink Agent?"
										description={<p>Its paired chats will stop using this channel.</p>}
										confirmLabel="Unlink Agent"
										destructive
										onConfirm={() =>
											unlinkAgent.execute({ agentId: link.agent_id, linkId: link.id })
										}
									>
										<Button
											variant="ghost"
											size="icon-sm"
											className={channelDetailPageClasses.textMutedForegroundHoverTextDestructive}
											aria-label="Unlink Agent"
										>
											<Unplug className={channelDetailPageClasses.size2} />
										</Button>
									</ConfirmAction>
								) : null}
							</div>
						</div>
					))}
				</div>
			)}

			<ChannelPairingDialog
				accountId={accountId}
				provider={provider}
				channelName={channelName}
				flow={pairing}
			/>
		</div>
	);
}

// ── Activity ─────────────────────────────────────────────────────────────────

function ActivityTab({ accountId }: { accountId: string }) {
	const activity = useChannelActivity(accountId);
	if (activity.isLoading) return <Skeleton className={channelDetailPageClasses.hWFullRoundedLg3} />;
	if (shouldBlockQueryError(activity.error, activity.data)) {
		return (
			<ApiErrorPanel
				error={activity.error}
				onRetry={() => activity.refetch()}
				title="Couldn't load activity"
			/>
		);
	}
	const items = activity.data?.items ?? [];

	if (items.length === 0) {
		return (
			<EmptyState
				icon={MessageSquareDashed}
				title="No activity yet"
				description="Messages and delivery events will show up here."
			/>
		);
	}

	return (
		<div className={channelDetailPageClasses.flexFlexColGap3}>
			{items.map((item: ChannelActivityItem) => (
				<ActivityRow key={item.id} item={item} />
			))}
		</div>
	);
}

function ActivityRow({ item }: { item: ChannelActivityItem }) {
	const inbound = item.direction === "inbound";
	const isEvent = item.kind === "debug_event";
	const error = channelActivityErrorSummary(item);

	return (
		<div className={cn(ENTITY_CARD_BASE, "flex items-start gap-3")}>
			<IconChip size="sm">
				{isEvent ? <TerminalSquare /> : inbound ? <ArrowDownLeft /> : <ArrowUpRight />}
			</IconChip>
			<div className={channelDetailPageClasses.minWFlex}>
				<div className={channelDetailPageClasses.flexFlexWrapItemsCenterGap2}>
					<span className={channelDetailPageClasses.textXsFontMediumCapitalize}>
						{isEvent ? (item.stage ?? "event") : inbound ? "Inbound" : "Outbound"}
					</span>
					{item.delivery_status ? <DeliveryBadge status={item.delivery_status} /> : null}
					<span className={channelDetailPageClasses.shrinkTextXsTextMutedForegroundSmMlAuto}>
						{relativeTime(item.created_at)}
					</span>
				</div>
				{item.text ? <p className={channelDetailPageClasses.mtTextSm}>{item.text}</p> : null}
				{error ? (
					<p className={channelDetailPageClasses.mtFlexItemsStartGap}>
						<TriangleAlert className={channelDetailPageClasses.mtSizeShrink} />
						{error}
					</p>
				) : null}
				{item.external_chat_id ? (
					<div className={channelDetailPageClasses.mt}>
						<CopyInline value={item.external_chat_id} label="external chat ID" />
					</div>
				) : null}
			</div>
		</div>
	);
}

// ── Health ───────────────────────────────────────────────────────────────────

function HealthTab({ accountId }: { accountId: string }) {
	const health = useChannelHealth();
	if (health.isLoading) return <Skeleton className={channelDetailPageClasses.hWFullRoundedLg3} />;
	if (shouldBlockQueryError(health.error, health.data)) {
		return (
			<ApiErrorPanel
				error={health.error}
				onRetry={() => health.refetch()}
				title={agentSurfaceCopy.couldnTLoadChannelHealth}
			/>
		);
	}
	const h = health.data?.items.find((x) => x.account_id === accountId);
	if (!h)
		return (
			<EmptyState
				title="Health unavailable"
				description="Channel health data isn't available yet."
			/>
		);

	const stats = [
		{ label: "Pending inbound", value: h.pending_inbox },
		{ label: "Pending outbound", value: h.pending_deliveries },
		{ label: "In progress", value: h.in_progress_deliveries },
		{ label: "Failed", value: h.failed_deliveries },
	];
	const transport = h.native_transport ? nativeTransportSummary(h.native_transport) : null;
	const summary = channelHealthSummary(h);
	const errorSummary = channelHealthErrorSummary(h);

	return (
		<div className={channelDetailPageClasses.flexFlexColGap}>
			<div className={channelDetailPageClasses.flexFlexWrapItemsCenterGap2}>
				<HealthBadge health={h} />
				<span className={channelDetailPageClasses.textXsTextMutedForeground}>{summary.detail}</span>
			</div>

			<div className={channelDetailPageClasses.gridGridColsGapSmGridCols}>
				{stats.map((s) => (
					<div key={s.label} className={ENTITY_CARD_BASE}>
						<div className={channelDetailPageClasses.textXlFontSemiboldTabularNums}>{s.value}</div>
						<div className={channelDetailPageClasses.textXsTextMutedForeground}>{s.label}</div>
					</div>
				))}
			</div>

			{errorSummary ? (
				<div
					className={cn(
						ENTITY_CARD_BASE,
						"flex flex-col gap-1 border-destructive/30 bg-destructive/5",
					)}
				>
					<div className={channelDetailPageClasses.flexItemsCenterGapTextSm}>
						<TriangleAlert className={channelDetailPageClasses.size} />
						Last error
					</div>
					<p className={channelDetailPageClasses.textSmTextDestructive}>{errorSummary}</p>
					<p className={channelDetailPageClasses.textXsTextMutedForeground}>
						Reported {relativeTime(h.last_error_at)}
					</p>
				</div>
			) : null}

			{transport ? (
				<div className={ENTITY_CARD_BASE}>
					<SectionLabel className={channelDetailPageClasses.mbPx}>Message transport</SectionLabel>
					<dl className={channelDetailPageClasses.gridGapTextSmSmGridCols}>
						<div>
							<dt className={channelDetailPageClasses.textXsTextMutedForeground}>
								{agentSurfaceCopy.status}
							</dt>
							<dd className={channelDetailPageClasses.mtFontMedium}>{transport.status}</dd>
						</div>
						<div>
							<dt className={channelDetailPageClasses.textXsTextMutedForeground}>Connection</dt>
							<dd className={channelDetailPageClasses.mtFontMedium}>{transport.connection}</dd>
						</div>
						<div>
							<dt className={channelDetailPageClasses.textXsTextMutedForeground}>
								Message delivery
							</dt>
							<dd className={channelDetailPageClasses.mtFontMedium}>{transport.delivery}</dd>
						</div>
					</dl>
				</div>
			) : null}
		</div>
	);
}

// ── Commands ─────────────────────────────────────────────────────────────────

function CommandsTab({ accountId, provider }: { accountId: string; provider: string }) {
	const sync = useSyncCommands(accountId);
	const meta = providerMeta(provider);
	const supportsCommands = provider === "telegram" || provider === "discord";
	const commands = sync.data?.commands ?? [];
	const [syncing, setSyncing] = useState(false);
	const syncLockedRef = useRef(false);

	function syncCommands() {
		if (syncLockedRef.current) return;
		syncLockedRef.current = true;
		setSyncing(true);
		void (async () => {
			try {
				await sync.mutateAsync();
			} catch {
				// useSyncCommands already surfaces the API error.
			} finally {
				syncLockedRef.current = false;
				setSyncing(false);
			}
		})();
	}

	return (
		<div className={channelDetailPageClasses.flexFlexColGap}>
			<InfoCard icon={KeyRound} title="Pairing commands">
				{supportsCommands
					? `Publish Clawdi’s pairing commands to ${meta.label}.`
					: `${meta.label} does not support pairing commands.`}
			</InfoCard>

			{supportsCommands ? (
				<>
					<Button onClick={syncCommands} disabled={syncing}>
						{syncing ? (
							<Spinner className={channelDetailPageClasses.size} />
						) : (
							<RefreshCw className={channelDetailPageClasses.size} />
						)}
						{syncing ? "Publishing…" : "Publish commands"}
					</Button>
					{commands.length > 0 ? (
						<div className={cn(ENTITY_CARD_BASE, "flex flex-col gap-2")}>
							<div className={channelDetailPageClasses.textXsFontMediumTextSuccessMutedForeground}>
								Published {commands.length} command{commands.length === 1 ? "" : "s"}
							</div>
							{commands.map((c) => (
								<div
									key={String(c.name)}
									className={channelDetailPageClasses.flexItemsBaselineGapTextSm}
								>
									<code className={channelDetailPageClasses.fontMonoTextXs}>/{String(c.name)}</code>
									<span className={channelDetailPageClasses.textMutedForeground}>
										{String(c.description)}
									</span>
								</div>
							))}
						</div>
					) : sync.data ? (
						<EmptyState
							variant="inset"
							description="No pairing commands are available to publish."
						/>
					) : null}
				</>
			) : null}
		</div>
	);
}
