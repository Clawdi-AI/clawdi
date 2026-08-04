"use client";

import { Link, useRouter } from "@tanstack/react-router";
import {
	ArrowDownLeft,
	ArrowUpRight,
	Bot,
	KeyRound,
	type LucideIcon,
	MessageSquareDashed,
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
import { EmptyState } from "@/components/empty-state";
import { ENTITY_CARD_BASE, EntityHeader } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import { isHostedRuntime } from "@/hosted/runtimes";
import { nativeTransportSummary } from "@/hosted/v2/channels/channel-detail-page.logic";
import { channelHealthSummary } from "@/hosted/v2/channels/channel-health-summary";
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
} from "@/hosted/v2/channels/channels-hooks";
import { agentSectionLink } from "@/lib/agent-routes";
import { isApiNotFoundError } from "@/lib/api-errors";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn, relativeTime } from "@/lib/utils";

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

function runtimeNameFormatter(env: { agent_type?: string | null }) {
	const runtime = env.agent_type;
	return runtime && isHostedRuntime(runtime)
		? (name: string) => deploymentDisplayName(name, runtime)
		: undefined;
}

function AgentName({
	env,
	fallback,
	meta,
}: {
	env: Environment | null;
	fallback: string;
	meta?: ReactNode[];
}) {
	if (!env) {
		return (
			<EntityHeader
				className="min-w-0 flex-1"
				icon={
					<IconChip size="sm">
						<Bot />
					</IconChip>
				}
				title={deploymentDisplayName(fallback)}
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
			formatName={runtimeNameFormatter(env)}
			className="min-w-0 flex-1"
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
		<div className="rounded-lg border bg-card p-4">
			<div className="flex items-start gap-3">
				<IconChip size="sm" tint="bg-primary/10 text-primary" className="size-9 [&>svg]:size-5">
					<Icon />
				</IconChip>
				<div className="min-w-0 flex-1 space-y-1">
					<div className="text-sm font-medium">{title}</div>
					<p className="text-sm text-muted-foreground">{children}</p>
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
		<div className="flex flex-wrap items-center justify-between gap-2">
			<SectionLabel count={count}>{label}</SectionLabel>
			{action ? <div className="shrink-0">{action}</div> : null}
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
				<div className="flex items-center gap-3">
					<Skeleton className="size-12 shrink-0 rounded-xl" />
					<div className="min-w-0 flex-1">
						<Skeleton className="h-6 w-52 max-w-full" />
						<Skeleton className="mt-2 h-4 w-40 max-w-full" />
						<Skeleton className="mt-2 h-5 w-32 max-w-full rounded-full" />
					</div>
				</div>
				<div className="flex flex-col gap-4">
					<Skeleton className="h-9 w-full max-w-xl rounded-lg" />
					<Skeleton className="h-64 w-full rounded-lg" />
				</div>
			</div>
		);
	}

	if (isApiNotFoundError(channel.error) || shouldBlockQueryError(channel.error, channel.data)) {
		return (
			<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
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
				<EmptyState
					icon={MessageSquareDashed}
					title="Channel not found"
					description="This channel may have been removed."
					action={
						<Button variant="outline" onClick={() => void router.navigate({ href: "/channels" })}>
							Back to Channels
						</Button>
					}
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
			<PageHeader
				title={ch.name}
				description={meta.label}
				icon={<EntityIcon kind="channel" id={ch.provider} label={meta.label} size="lg" />}
				status={
					!isNormalChannelStatus(ch.status) ||
					(healthItem && !isNormalChannelHealth(healthItem.health_status)) ? (
						<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
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
							className="text-muted-foreground hover:text-destructive"
							disabled={removing}
						>
							{removing ? (
								<Spinner className="size-4" />
							) : disconnectsWhatsApp ? (
								<Unplug className="size-4" />
							) : (
								<Trash2 className="size-4" />
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
					a test message and confirm activity and health before relying on this channel. To replace
					credentials, remove the channel and reconnect it.
				</InfoCard>
			) : null}

			<section data-channel-linked-agents className="flex flex-col gap-3">
				<AgentsTab accountId={id} />
			</section>

			<Tabs defaultValue="activity" className="min-w-0">
				<TabsList className="h-auto flex-wrap justify-start">
					<TabsTrigger value="activity">Activity</TabsTrigger>
					<TabsTrigger value="health">Health</TabsTrigger>
					{providerUnavailable ? null : <TabsTrigger value="commands">Commands</TabsTrigger>}
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

function AgentsTab({ accountId }: { accountId: string }) {
	const links = useChannelAgentLinks(accountId);
	const envs = useEnvironments();

	if (links.isLoading) return <Skeleton className="h-24 w-full rounded-lg" />;
	if (shouldBlockQueryError(links.error, links.data)) {
		return (
			<ApiErrorPanel
				error={links.error}
				onRetry={() => links.refetch()}
				title="Couldn't load linked Agents"
			/>
		);
	}
	const items = links.data ?? [];

	return (
		<div className="flex flex-col gap-3">
			{shouldBlockQueryError(envs.error, envs.data) ? (
				<ApiErrorPanel
					error={envs.error}
					onRetry={() => envs.refetch()}
					title="Couldn't load Agent names"
				/>
			) : null}
			<SectionHeader label="Linked Agents" count={items.length} />

			{items.length === 0 ? (
				<EmptyState
					variant="inset"
					title="No Agents linked"
					description="Connect this bot from an Agent’s Channels page."
				/>
			) : (
				<div className={CHANNEL_RELATION_LIST_CLASS}>
					{items.map((link: ChannelAgentLink) => (
						<Link
							key={link.id}
							{...agentSectionLink(link.agent_id, "channels")}
							data-channel-agent-link-id={link.id}
							className={cn(
								CHANNEL_RELATION_ROW_CLASS,
								"group transition-colors hover:bg-muted/50",
							)}
						>
							<AgentName
								env={findEnv(envs.data, link.agent_id)}
								fallback={link.agent_id}
								meta={[
									...(isNormalChannelStatus(link.status)
										? []
										: [<ChannelStatusBadge key="status" status={link.status} />]),
									<span key="linked">Linked {relativeTime(link.created_at)}</span>,
								]}
							/>
							<span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground group-hover:text-foreground">
								Channels
								<ArrowUpRight className="size-3.5" />
							</span>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}

// ── Activity ─────────────────────────────────────────────────────────────────

function ActivityTab({ accountId }: { accountId: string }) {
	const activity = useChannelActivity(accountId);
	if (activity.isLoading) return <Skeleton className="h-32 w-full rounded-lg" />;
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
		<div className="flex flex-col gap-2">
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
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-xs font-medium capitalize">
						{isEvent ? (item.stage ?? "event") : inbound ? "Inbound" : "Outbound"}
					</span>
					{item.delivery_status ? <DeliveryBadge status={item.delivery_status} /> : null}
					<span className="shrink-0 text-xs text-muted-foreground sm:ml-auto">
						{relativeTime(item.created_at)}
					</span>
				</div>
				{item.text ? <p className="mt-1 text-sm">{item.text}</p> : null}
				{error ? (
					<p className="mt-1 flex items-start gap-1 text-xs text-destructive">
						<TriangleAlert className="mt-0.5 size-3 shrink-0" />
						{error}
					</p>
				) : null}
				{item.external_chat_id ? (
					<div className="mt-1">
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
	if (health.isLoading) return <Skeleton className="h-32 w-full rounded-lg" />;
	if (shouldBlockQueryError(health.error, health.data)) {
		return (
			<ApiErrorPanel
				error={health.error}
				onRetry={() => health.refetch()}
				title="Couldn't load health"
			/>
		);
	}
	const h = health.data?.items.find((x) => x.account_id === accountId);
	if (!h)
		return <EmptyState title="No health data" description="Health metrics aren't available yet." />;

	const stats = [
		{ label: "Pending inbox", value: h.pending_inbox },
		{ label: "Pending deliveries", value: h.pending_deliveries },
		{ label: "In progress", value: h.in_progress_deliveries },
		{ label: "Failed deliveries", value: h.failed_deliveries },
	];
	const transport = h.native_transport ? nativeTransportSummary(h.native_transport) : null;
	const summary = channelHealthSummary(h);
	const errorSummary = channelHealthErrorSummary(h);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<HealthBadge health={h} />
				<span className="text-xs text-muted-foreground">{summary.detail}</span>
			</div>

			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{stats.map((s) => (
					<div key={s.label} className={ENTITY_CARD_BASE}>
						<div className="text-2xl font-semibold tabular-nums">{s.value}</div>
						<div className="text-xs text-muted-foreground">{s.label}</div>
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
					<div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
						<TriangleAlert className="size-4" />
						Last error
					</div>
					<p className="text-sm text-destructive/90">{errorSummary}</p>
					<p className="text-xs text-muted-foreground">Reported {relativeTime(h.last_error_at)}</p>
				</div>
			) : null}

			{transport ? (
				<div className={ENTITY_CARD_BASE}>
					<SectionLabel className="mb-3 px-0">Message transport</SectionLabel>
					<dl className="grid gap-3 text-sm sm:grid-cols-3">
						<div>
							<dt className="text-xs text-muted-foreground">Status</dt>
							<dd className="mt-0.5 font-medium">{transport.status}</dd>
						</div>
						<div>
							<dt className="text-xs text-muted-foreground">Connection</dt>
							<dd className="mt-0.5 font-medium">{transport.connection}</dd>
						</div>
						<div>
							<dt className="text-xs text-muted-foreground">Message delivery</dt>
							<dd className="mt-0.5 font-medium">{transport.delivery}</dd>
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
		<div className="flex flex-col gap-4">
			<InfoCard icon={KeyRound} title="Pairing commands">
				{supportsCommands
					? `Publish Clawdi’s pairing commands to ${meta.label}.`
					: `${meta.label} doesn't support pairing commands.`}
			</InfoCard>

			{supportsCommands ? (
				<>
					<Button onClick={syncCommands} disabled={syncing}>
						{syncing ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
						{syncing ? "Syncing…" : "Sync commands"}
					</Button>
					{commands.length > 0 ? (
						<div className={cn(ENTITY_CARD_BASE, "flex flex-col gap-2")}>
							<div className="text-xs font-medium text-success-muted-foreground">
								Synced {commands.length} command{commands.length === 1 ? "" : "s"}
							</div>
							{commands.map((c) => (
								<div key={String(c.name)} className="flex items-baseline gap-2 text-sm">
									<code className="font-mono text-xs">/{String(c.name)}</code>
									<span className="text-muted-foreground">{String(c.description)}</span>
								</div>
							))}
						</div>
					) : sync.data ? (
						<EmptyState
							variant="inset"
							description="Command sync completed. No pairing commands were returned."
						/>
					) : null}
				</>
			) : null}
		</div>
	);
}
