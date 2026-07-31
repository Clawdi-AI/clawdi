"use client";

import { useRouter } from "@tanstack/react-router";
import {
	ArrowDownLeft,
	ArrowUpRight,
	ExternalLink,
	KeyRound,
	Link2,
	Link2Off,
	type LucideIcon,
	MessageSquareDashed,
	QrCode,
	RefreshCw,
	Smartphone,
	TerminalSquare,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import {
	AgentLabel,
	AgentSourceBadgeForEnvironment,
	agentTextLabel,
} from "@/components/dashboard/agent-label";
import { EmptyState } from "@/components/empty-state";
import { ENTITY_CARD_BASE, EntityHeader } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import { isHostedRuntime } from "@/hosted/runtimes";
import {
	nativeTransportSummary,
	pairCodeExpiryLabel,
	pairCodeRequiresExplicitAgent,
	telegramPairDeepLink,
} from "@/hosted/v2/channels/channel-detail-page.logic";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import type {
	ChannelActivityItem,
	ChannelAgentLink,
	ChannelBinding,
} from "@/hosted/v2/channels/channel-types";
import {
	ChannelStatusBadge,
	CopyInline,
	DeliveryBadge,
	HealthBadge,
} from "@/hosted/v2/channels/channel-ui";
import {
	useChannel,
	useChannelActivity,
	useChannelAgentLinks,
	useChannelBindings,
	useChannelHealth,
	useCreatePairCode,
	useCreateWhatsappTenantCred,
	useDeleteChannel,
	useDeleteChannelBinding,
	useEnvironments,
	useRevokeWhatsappTenantCred,
	useSyncCommands,
	useUnlinkChannelAgent,
	useWhatsappTenantCreds,
} from "@/hosted/v2/channels/channels-hooks";
import { LinkAgentDialog } from "@/hosted/v2/channels/link-agent-dialog";
import {
	pairCodeExpired,
	WHATSAPP_COMING_SOON_MESSAGE,
	WHATSAPP_LINKING_READY,
} from "@/hosted/v2/channels/link-agent-dialog.logic";
import {
	type AgentOwnership,
	agentOwnershipKindFromId,
	useAgentOwnership,
} from "@/lib/agent-ownership";
import { cn, relativeTime } from "@/lib/utils";

const PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");
const LIST_TAB_CLASS = "mt-4 min-w-0";
const FORM_TAB_CLASS = "mt-4 min-w-0 max-w-xl";

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

/** "machine · agent-type" label for an agent id, with a safe missing-agent fallback. */
function envName(
	envs: EnvironmentList,
	agentId: string,
	ownership: AgentOwnership | null,
	includeSource = true,
): string {
	const env = findEnv(envs, agentId);
	return env
		? agentTextLabel(env, {
				includeSource,
				ownershipKind: agentOwnershipKindFromId(env.id, ownership),
				formatName: runtimeNameFormatter(env),
			})
		: deploymentDisplayName(agentId);
}

function AgentName({ env, fallback }: { env: Environment | null; fallback: string }) {
	const ownership = useAgentOwnership();
	if (!env) {
		return <span className="truncate text-sm font-medium">{deploymentDisplayName(fallback)}</span>;
	}
	const ownershipKind = agentOwnershipKindFromId(env.id, ownership);
	return (
		<AgentLabel
			machineName={env.machine_name}
			displayName={env.display_name}
			defaultName={env.default_name}
			type={env.agent_type}
			avatarUrl={env.avatar_url}
			size="sm"
			formatName={runtimeNameFormatter(env)}
			titleAdornment={
				<AgentSourceBadgeForEnvironment env={env} ownershipKind={ownershipKind} compact />
			}
			className="min-w-0"
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

function SetupStepCard({
	step,
	title,
	description,
	children,
}: {
	step: number;
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<section data-channel-setup-step={step} className="rounded-xl border bg-card p-4 sm:p-5">
			<div className="mb-4 flex items-start gap-3">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
					{step}
				</div>
				<div className="min-w-0">
					<h2 className="font-semibold">{title}</h2>
					<p className="text-sm text-muted-foreground">{description}</p>
				</div>
			</div>
			{children}
		</section>
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
				await del.mutateAsync(id);
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

	if (channel.error) {
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

	return (
		<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
			<PageHeader
				title={ch.name}
				description={`${meta.label} · ${ch.visibility === "public" ? "Ready-to-go bot" : "Your bot"}`}
				icon={<EntityIcon kind="channel" id={ch.provider} label={meta.label} size="lg" />}
				status={
					<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
						<ChannelStatusBadge status={ch.status} />
						{healthItem ? <HealthBadge status={healthItem.health_status} /> : null}
					</div>
				}
				actions={
					<ConfirmAction
						title={`Remove ${ch.name}?`}
						description="Agents linked to this channel will stop sending and receiving. This can't be undone."
						confirmLabel="Remove channel"
						destructive
						onConfirm={removeChannel}
					>
						<Button
							variant="outline"
							className="text-muted-foreground hover:text-destructive"
							disabled={removing}
						>
							{removing ? <Spinner className="size-4" /> : <Trash2 className="size-4" />}
							{removing ? "Removing…" : "Remove"}
						</Button>
					</ConfirmAction>
				}
			/>

			{providerUnavailable ? (
				<InfoCard icon={TriangleAlert} title="Provider unavailable">
					This provider is no longer available for new native channels. Existing channel data
					remains visible, and you can remove the channel.
				</InfoCard>
			) : null}
			{ch.provider === "discord" && !providerUnavailable ? (
				<InfoCard icon={TriangleAlert} title="Verify Discord credentials">
					Clawdi stores Discord credentials during setup but does not verify them with Discord. Send
					a test message and confirm activity and health before relying on this channel. To replace
					credentials, remove the channel and reconnect it.
				</InfoCard>
			) : null}

			<div data-channel-setup-flow className="flex max-w-3xl flex-col gap-4">
				<SetupStepCard
					step={1}
					title="Link Agent"
					description="Choose which Agent uses this bot. Credentials sync automatically."
				>
					<AgentsTab
						accountId={id}
						accountName={ch.name}
						provider={ch.provider}
						readOnly={providerUnavailable}
					/>
				</SetupStepCard>
				{providerUnavailable ? (
					<section className="rounded-xl border bg-card p-4 sm:p-5">
						<SectionHeader label="Paired chats" />
						<div className="mt-3">
							<BindingsTab accountId={id} />
						</div>
					</section>
				) : (
					<SetupStepCard
						step={2}
						title={ch.provider === "telegram" ? "Pair Telegram" : `Pair ${meta.label}`}
						description={
							ch.provider === "telegram"
								? "Open Telegram from the QR or link, with a short manual command for groups."
								: "Use the short pairing command in the conversation you want."
						}
					>
						<PairCodeTab accountId={id} provider={ch.provider} />
						<div className="mt-5 border-t pt-5">
							<SectionHeader label="Paired chats" />
							<div className="mt-3">
								<BindingsTab accountId={id} />
							</div>
						</div>
					</SetupStepCard>
				)}
			</div>

			<Tabs
				defaultValue={ch.provider === "whatsapp" && !providerUnavailable ? "devices" : "activity"}
				className="min-w-0"
			>
				<TabsList className="h-auto flex-wrap justify-start">
					{ch.provider === "whatsapp" && !providerUnavailable ? (
						<TabsTrigger value="devices">Linked devices</TabsTrigger>
					) : null}
					<TabsTrigger value="activity">Activity</TabsTrigger>
					<TabsTrigger value="health">Health</TabsTrigger>
					{providerUnavailable ? null : <TabsTrigger value="commands">Commands</TabsTrigger>}
				</TabsList>

				{ch.provider === "whatsapp" && !providerUnavailable ? (
					<TabsContent value="devices" className={FORM_TAB_CLASS}>
						<WhatsAppDevicesTab accountId={id} />
					</TabsContent>
				) : null}
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
	accountName,
	provider,
	readOnly = false,
}: {
	accountId: string;
	accountName: string;
	provider: string;
	readOnly?: boolean;
}) {
	const links = useChannelAgentLinks(accountId);
	const envs = useEnvironments();
	const unlink = useUnlinkChannelAgent(accountId);
	const [linkOpen, setLinkOpen] = useState(false);
	const unlinkingLinksRef = useRef<Set<string>>(new Set());
	const [unlinkingLinks, setUnlinkingLinks] = useState<ReadonlySet<string>>(() => new Set());
	function unlinkAgent(linkId: string) {
		if (unlinkingLinksRef.current.has(linkId)) return;
		unlinkingLinksRef.current.add(linkId);
		setUnlinkingLinks((prev) => new Set(prev).add(linkId));
		void (async () => {
			try {
				await unlink.mutateAsync(linkId);
			} catch {
				// useUnlinkChannelAgent already surfaces the API error.
			} finally {
				unlinkingLinksRef.current.delete(linkId);
				setUnlinkingLinks((prev) => {
					const next = new Set(prev);
					next.delete(linkId);
					return next;
				});
			}
		})();
	}

	if (links.isLoading) return <Skeleton className="h-24 w-full rounded-lg" />;
	if (links.error) {
		return (
			<ApiErrorPanel
				error={links.error}
				onRetry={() => links.refetch()}
				title="Couldn't load linked agents"
			/>
		);
	}
	const items = links.data ?? [];

	return (
		<div className="flex flex-col gap-3">
			{envs.error ? (
				<ApiErrorPanel
					error={envs.error}
					onRetry={() => envs.refetch()}
					title="Couldn't load agent names"
				/>
			) : null}
			<SectionHeader
				label="Linked agents"
				count={items.length}
				action={
					readOnly ? null : (
						<Button size="sm" onClick={() => setLinkOpen(true)}>
							<Link2 className="size-3.5" />
							Link an agent
						</Button>
					)
				}
			/>

			{items.length === 0 ? (
				<EmptyState
					icon={Link2}
					title="No agents linked"
					description={
						readOnly
							? "No agents are linked to this channel."
							: "Link an agent so it can send and receive on this channel."
					}
				/>
			) : (
				<div className="flex flex-col gap-2">
					{items.map((link: ChannelAgentLink) => {
						const isUnlinking = unlinkingLinks.has(link.id);
						return (
							<div key={link.id} className={ENTITY_CARD_BASE}>
								<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
									<div className="min-w-0">
										<AgentName env={findEnv(envs.data, link.agent_id)} fallback={link.agent_id} />
										<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
											<ChannelStatusBadge status={link.status} />
											<span>Linked {relativeTime(link.created_at)}</span>
										</div>
									</div>
									{readOnly ? null : (
										<div className="flex shrink-0 flex-wrap items-center gap-1.5">
											<ConfirmAction
												title="Unlink this agent?"
												description={<p>It stops sending and receiving on {accountName}.</p>}
												confirmLabel="Unlink"
												destructive
												onConfirm={() => unlinkAgent(link.id)}
											>
												<Button
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground hover:text-destructive"
													disabled={isUnlinking}
													aria-label="Unlink agent"
												>
													{isUnlinking ? (
														<Spinner className="size-4" />
													) : (
														<Link2Off className="size-4" />
													)}
												</Button>
											</ConfirmAction>
										</div>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}

			{readOnly ? null : (
				<LinkAgentDialog
					open={linkOpen}
					onOpenChange={setLinkOpen}
					accountId={accountId}
					accountName={accountName}
					provider={provider}
				/>
			)}
		</div>
	);
}

// ── WhatsApp linked devices (Baileys tenant credentials) ─────────────────────

function WhatsAppDevicesTab({ accountId }: { accountId: string }) {
	const links = useChannelAgentLinks(accountId);
	const envs = useEnvironments();
	const creds = useWhatsappTenantCreds(accountId);
	const create = useCreateWhatsappTenantCred(accountId);
	const revoke = useRevokeWhatsappTenantCred(accountId);
	const ownership = useAgentOwnership();
	const [linkId, setLinkId] = useState("");
	const [creatingCredential, setCreatingCredential] = useState(false);
	const createCredentialLockedRef = useRef(false);
	const revokingCredentialsRef = useRef<Set<string>>(new Set());
	const [revokingCredentials, setRevokingCredentials] = useState<ReadonlySet<string>>(
		() => new Set(),
	);

	const linkItems = links.data ?? [];
	const devices = creds.data ?? [];
	// Default to the only link when there's exactly one.
	const effectiveLink = linkId || (linkItems.length === 1 ? linkItems[0].id : "");
	const linkSelectItems = linkItems.map((link) => ({
		value: link.id,
		label: envName(envs.data, link.agent_id, ownership),
	}));

	function linkDevice() {
		if (!effectiveLink || createCredentialLockedRef.current) return;
		createCredentialLockedRef.current = true;
		setCreatingCredential(true);
		void (async () => {
			try {
				await create.execute({ agent_link_id: effectiveLink });
			} catch {
				// useCreateWhatsappTenantCred already surfaces the API error.
			} finally {
				createCredentialLockedRef.current = false;
				setCreatingCredential(false);
			}
		})();
	}

	function revokeDevice(credentialId: string) {
		if (revokingCredentialsRef.current.has(credentialId)) return;
		revokingCredentialsRef.current.add(credentialId);
		setRevokingCredentials((prev) => new Set(prev).add(credentialId));
		void (async () => {
			try {
				await revoke.mutateAsync(credentialId);
			} catch {
				// useRevokeWhatsappTenantCred already surfaces the API error.
			} finally {
				revokingCredentialsRef.current.delete(credentialId);
				setRevokingCredentials((prev) => {
					const next = new Set(prev);
					next.delete(credentialId);
					return next;
				});
			}
		})();
	}

	return (
		<div className="flex flex-col gap-4">
			<InfoCard
				icon={Smartphone}
				title={WHATSAPP_LINKING_READY ? "Link a WhatsApp number" : "WhatsApp is coming soon"}
			>
				{WHATSAPP_LINKING_READY
					? "WhatsApp uses no bot token. Create secure access for an agent, then finish the link by scanning it in WhatsApp → Linked devices. The agent uses that access to complete pairing."
					: WHATSAPP_COMING_SOON_MESSAGE}
			</InfoCard>

			{!WHATSAPP_LINKING_READY ? (
				<Button disabled>
					<Smartphone className="size-4" />
					Coming soon
				</Button>
			) : links.isLoading ? (
				<Skeleton className="h-16 w-full rounded-lg" />
			) : links.error ? (
				<ApiErrorPanel
					error={links.error}
					onRetry={() => links.refetch()}
					title="Couldn't load linked agents"
				/>
			) : linkItems.length === 0 ? (
				<EmptyState
					variant="inset"
					title="Link an agent first"
					description="Each agent needs its own WhatsApp connection. Link an agent on the Agents tab, then come back."
				/>
			) : (
				<div className="flex flex-col gap-2">
					{envs.error ? (
						<ApiErrorPanel
							error={envs.error}
							onRetry={() => envs.refetch()}
							title="Couldn't load agent names"
						/>
					) : null}
					{linkItems.length > 1 ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="wa-agent">Agent</Label>
							<Select
								items={linkSelectItems}
								value={effectiveLink}
								onValueChange={(value) => {
									if (value !== null) setLinkId(value);
								}}
							>
								<SelectTrigger id="wa-agent">
									<SelectValue placeholder="Choose an agent" />
								</SelectTrigger>
								<SelectContent>
									{linkItems.map((l) => {
										const env = findEnv(envs.data, l.agent_id);
										return (
											<SelectItem
												key={l.id}
												value={l.id}
												label={envName(envs.data, l.agent_id, ownership)}
											>
												<AgentName env={env} fallback={l.agent_id} />
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
						</div>
					) : null}
					<Button onClick={linkDevice} disabled={!effectiveLink || creatingCredential}>
						{creatingCredential ? (
							<Spinner className="size-4" />
						) : (
							<Smartphone className="size-4" />
						)}
						{creatingCredential ? "Linking device…" : "Link a device"}
					</Button>
				</div>
			)}

			<div className="flex flex-col gap-2">
				<SectionLabel count={devices.length}>Linked devices</SectionLabel>
				{creds.isLoading ? (
					<Skeleton className="h-16 w-full rounded-lg" />
				) : creds.error ? (
					<ApiErrorPanel
						error={creds.error}
						onRetry={() => creds.refetch()}
						title="Couldn't load linked devices"
					/>
				) : devices.length === 0 ? (
					<EmptyState variant="inset" description="No devices linked yet." />
				) : (
					devices.map((d) => (
						<div
							key={d.credential_id}
							className={cn(ENTITY_CARD_BASE, "flex items-center justify-between gap-3")}
						>
							<EntityHeader
								className="min-w-0 flex-1"
								icon={
									<IconChip size="sm">
										<Smartphone />
									</IconChip>
								}
								title={
									d.jid ? <span className="font-mono text-xs">{d.jid}</span> : "Pending pairing"
								}
								titleAdornment={!d.jid ? <Spinner className="size-3" /> : undefined}
								meta={`${envName(envs.data, d.agent_id, ownership)} · added ${relativeTime(
									d.created_at,
								)}`}
							/>
							<ConfirmAction
								title="Unlink this device?"
								description={<p>The WhatsApp credential is revoked. This can't be undone.</p>}
								confirmLabel="Unlink"
								destructive
								onConfirm={() => revokeDevice(d.credential_id)}
							>
								<Button
									variant="ghost"
									size="icon-sm"
									className="text-muted-foreground hover:text-destructive"
									disabled={revokingCredentials.has(d.credential_id)}
									aria-label="Unlink device"
								>
									{revokingCredentials.has(d.credential_id) ? (
										<Spinner className="size-4" />
									) : (
										<Trash2 className="size-4" />
									)}
								</Button>
							</ConfirmAction>
						</div>
					))
				)}
			</div>
		</div>
	);
}

// ── Pair code ────────────────────────────────────────────────────────────────

const TTL_OPTIONS = [
	{ value: "900", label: "15 minutes" },
	{ value: "3600", label: "1 hour" },
	{ value: "86400", label: "24 hours" },
];

type PairCodeResult = {
	agent_link_id: string;
	code: string;
	expires_at: string;
	pairing_command: string;
	bot_username: string | null;
	deep_link: string | null;
	qr_payload: string | null;
};

function PairCodeTab({ accountId, provider }: { accountId: string; provider: string }) {
	const envs = useEnvironments();
	const links = useChannelAgentLinks(accountId);
	const create = useCreatePairCode(accountId);
	const ownership = useAgentOwnership();
	const [agentLinkId, setAgentLinkId] = useState("");
	const [ttl, setTtl] = useState("900");
	const [result, setResult] = useState<PairCodeResult | null>(null);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [generating, setGenerating] = useState(false);
	const linkedAgents = links.data ?? [];
	const agentItems = linkedAgents.map((link) => ({
		value: link.id,
		label: envName(envs.data, link.agent_id, ownership),
	}));
	const generateLocked = useRef(false);
	const isGenerating = generating || create.isPending;
	const linkedAgentCount = links.data?.length ?? 0;
	const requiresExplicitAgent = pairCodeRequiresExplicitAgent(linkedAgentCount);
	const selectedLink =
		linkedAgents.find((candidate) => candidate.id === agentLinkId) ??
		(linkedAgentCount === 1 ? linkedAgents[0] : undefined);
	const selectionMessage =
		requiresExplicitAgent && !selectedLink && !links.isLoading && !links.error
			? linkedAgentCount === 0
				? "Link an Agent above before creating a pairing link."
				: "This channel has multiple linked agents. Choose the agent for this pairing code."
			: null;
	const canGenerate = !isGenerating && !links.isLoading && !links.error && Boolean(selectedLink);
	const resultExpired = result ? pairCodeExpired(result.expires_at, nowMs) : false;
	const validTelegramLink =
		result && provider === "telegram"
			? telegramPairDeepLink({
					deepLink: result.deep_link,
					qrPayload: result.qr_payload,
					botUsername: result.bot_username,
					code: result.code,
				})
			: null;

	useEffect(() => {
		if (!result) return;
		setNowMs(Date.now());
		const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(interval);
	}, [result]);

	useEffect(() => {
		if (!result || !links.data) return;
		if (!links.data.some((link) => link.id === result.agent_link_id)) setResult(null);
	}, [links.data, result]);

	function generate() {
		if (!canGenerate || generateLocked.current) return;
		generateLocked.current = true;
		setGenerating(true);
		setResult(null);
		void (async () => {
			try {
				if (!selectedLink) return;
				const data = await create.execute({
					agent_link_id: selectedLink.id,
					ttl_seconds: Number(ttl),
				});
				setResult({
					agent_link_id: data.agent_link_id,
					code: data.code,
					expires_at: data.expires_at,
					pairing_command: data.pairing_command,
					bot_username: data.bot_username ?? null,
					deep_link: data.deep_link ?? null,
					qr_payload: data.qr_payload ?? null,
				});
			} catch {
				// useSensitiveAction already surfaces the API error.
			} finally {
				generateLocked.current = false;
				setGenerating(false);
			}
		})();
	}

	if (provider === "whatsapp" && !WHATSAPP_LINKING_READY) {
		return (
			<InfoCard icon={TriangleAlert} title="WhatsApp is coming soon">
				{WHATSAPP_COMING_SOON_MESSAGE}
			</InfoCard>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="pair-agent">Agent</Label>
					{envs.isLoading || links.isLoading ? (
						<Skeleton className="h-10 w-full rounded-md" />
					) : (
						<Select
							items={agentItems}
							value={agentLinkId}
							onValueChange={(value) => {
								if (value !== null) {
									setAgentLinkId(value);
									setResult(null);
								}
							}}
							disabled={Boolean(links.error) || linkedAgentCount === 0 || isGenerating}
						>
							<SelectTrigger
								id="pair-agent"
								aria-describedby={selectionMessage ? "pair-agent-requirement" : undefined}
							>
								<SelectValue
									placeholder={requiresExplicitAgent ? "Choose a linked Agent" : "Use linked Agent"}
								/>
							</SelectTrigger>
							<SelectContent>
								{linkedAgents.map((link) => (
									<SelectItem
										key={link.id}
										value={link.id}
										label={envName(envs.data, link.agent_id, ownership)}
									>
										<AgentName env={findEnv(envs.data, link.agent_id)} fallback={link.agent_id} />
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					{selectionMessage ? (
						<p id="pair-agent-requirement" className="text-xs text-warning-muted-foreground">
							{selectionMessage}
						</p>
					) : null}
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="pair-ttl">Expires in</Label>
					<Select
						items={TTL_OPTIONS}
						value={ttl}
						onValueChange={(value) => {
							if (value !== null) setTtl(value);
						}}
						disabled={isGenerating}
					>
						<SelectTrigger id="pair-ttl">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{TTL_OPTIONS.map((o) => (
								<SelectItem key={o.value} value={o.value}>
									{o.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{envs.error ? (
				<ApiErrorPanel
					error={envs.error}
					onRetry={() => envs.refetch()}
					title="Couldn't load agents"
				/>
			) : null}
			{links.error ? (
				<ApiErrorPanel
					error={links.error}
					onRetry={() => links.refetch()}
					title="Couldn't load linked agents"
				/>
			) : null}

			<Button onClick={generate} disabled={!canGenerate}>
				<QrCode className="size-4" />
				{isGenerating
					? "Generating…"
					: provider === "telegram"
						? "Generate Telegram link"
						: "Generate pairing code"}
			</Button>

			{result ? (
				<div
					data-telegram-pair-result={provider === "telegram" ? "true" : undefined}
					className="flex flex-col gap-4 rounded-lg border border-primary/30 bg-primary/5 p-4"
				>
					<div className="text-sm font-medium text-primary">
						{provider === "telegram" ? "Telegram pairing link" : "Pairing code"}
					</div>
					{provider === "telegram" ? (
						validTelegramLink && !resultExpired ? (
							<div className="flex flex-col items-center gap-3">
								<div className="rounded-xl border bg-white p-3 shadow-sm">
									<QRCodeSVG
										value={validTelegramLink}
										size={192}
										role="img"
										aria-label="Telegram pairing QR code"
									/>
								</div>
								<Button
									render={<a href={validTelegramLink} target="_blank" rel="noopener noreferrer" />}
									nativeButton={false}
								>
									{result.bot_username
										? `Open @${result.bot_username.replace(/^@/, "")}`
										: "Open Telegram"}
									<ExternalLink className="size-4" />
								</Button>
								<CopyInline value={validTelegramLink} label="Telegram pairing link" />
							</div>
						) : (
							<div role="alert" className="rounded-md border border-warning/40 bg-background p-3">
								<p className="text-sm font-medium">
									{resultExpired ? "This Telegram link has expired" : "Telegram link unavailable"}
								</p>
								<p className="mt-1 text-xs text-muted-foreground">
									Generate a new pairing link. QR and Open Telegram stay disabled unless the server
									returns a valid t.me start link.
								</p>
							</div>
						)
					) : (
						<div className="font-mono text-3xl font-semibold tracking-[0.2em]">{result.code}</div>
					)}
					<p
						role="status"
						className={cn(
							"text-center text-sm font-medium",
							resultExpired ? "text-destructive" : "text-muted-foreground",
						)}
					>
						{pairCodeExpiryLabel(result.expires_at, nowMs)}
					</p>
					{!resultExpired ? (
						<details className="rounded-md border bg-background/70 px-3 py-2">
							<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
								Manual command
							</summary>
							<div className="mt-2">
								<CopyInline value={result.pairing_command} label="pairing command" />
							</div>
						</details>
					) : null}
				</div>
			) : null}
		</div>
	);
}

// ── Bindings (paired chats) ──────────────────────────────────────────────────

function BindingsTab({ accountId }: { accountId: string }) {
	const bindings = useChannelBindings(accountId);
	const links = useChannelAgentLinks(accountId);
	const envs = useEnvironments();
	const unpair = useDeleteChannelBinding(accountId);
	const unpairingRef = useRef<Set<string>>(new Set());
	const [unpairingIds, setUnpairingIds] = useState<ReadonlySet<string>>(() => new Set());

	function unpairChat(bindingId: string) {
		if (unpairingRef.current.has(bindingId)) return;
		unpairingRef.current.add(bindingId);
		setUnpairingIds((current) => new Set(current).add(bindingId));
		void (async () => {
			try {
				await unpair.mutateAsync(bindingId);
			} catch {
				// useDeleteChannelBinding surfaces the recoverable error.
			} finally {
				unpairingRef.current.delete(bindingId);
				setUnpairingIds((current) => {
					const next = new Set(current);
					next.delete(bindingId);
					return next;
				});
			}
		})();
	}

	if (bindings.isLoading) return <Skeleton className="h-24 w-full rounded-lg" />;
	if (bindings.error) {
		return (
			<ApiErrorPanel
				error={bindings.error}
				onRetry={() => bindings.refetch()}
				title="Couldn't load paired chats"
			/>
		);
	}
	const items = bindings.data ?? [];

	if (items.length === 0) {
		return (
			<EmptyState
				icon={MessageSquareDashed}
				title="No paired chats"
				description="Generate a pairing code, then send it from a chat to link it here."
			/>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{items.map((binding: ChannelBinding) => {
				const link = links.data?.find((candidate) => candidate.id === binding.agent_link_id);
				const threadLabel = bindingThreadLabel(binding);
				const isUnpairing = unpairingIds.has(binding.id);
				return (
					<div
						key={binding.id}
						data-channel-binding-id={binding.id}
						className={cn(
							ENTITY_CARD_BASE,
							"flex flex-col items-stretch gap-3 sm:flex-row sm:items-start",
						)}
					>
						<EntityHeader
							className="min-w-0 flex-1"
							icon={
								<IconChip size="sm">
									<MessageSquareDashed />
								</IconChip>
							}
							title={binding.external_chat_name ?? "Telegram chat"}
							meta={[
								<span key="type" className="capitalize">
									{binding.external_chat_type ?? "chat"}
								</span>,
								<ChannelStatusBadge key="status" status={binding.status} />,
								<CopyInline key="chat-id" value={binding.external_chat_id} label="chat ID" />,
								...(threadLabel ? [<span key="thread">Thread: {threadLabel}</span>] : []),
							]}
						/>
						<div className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
							{link ? (
								<div className="min-w-0 max-w-52">
									<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
										Agent
									</div>
									<AgentName env={findEnv(envs.data, link.agent_id)} fallback={link.agent_id} />
								</div>
							) : null}
							<ConfirmAction
								title={`Unpair ${binding.external_chat_name ?? "this chat"}?`}
								description="Only this chat will be disconnected. Other chats and the linked Agent stay active."
								confirmLabel="Unpair chat"
								destructive
								onConfirm={() => unpairChat(binding.id)}
							>
								<Button variant="outline" size="sm" disabled={isUnpairing}>
									{isUnpairing ? (
										<Spinner className="size-3.5" />
									) : (
										<Link2Off className="size-3.5" />
									)}
									{isUnpairing ? "Unpairing…" : "Unpair"}
								</Button>
							</ConfirmAction>
						</div>
					</div>
				);
			})}
		</div>
	);
}

function bindingThreadLabel(binding: ChannelBinding): string | null {
	if (!("thread_label" in binding) || typeof binding.thread_label !== "string") return null;
	return binding.thread_label.trim() || null;
}

// ── Activity ─────────────────────────────────────────────────────────────────

function ActivityTab({ accountId }: { accountId: string }) {
	const activity = useChannelActivity(accountId);
	if (activity.isLoading) return <Skeleton className="h-32 w-full rounded-lg" />;
	if (activity.error) {
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
	const error = item.delivery_last_error ?? item.error;

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
	if (health.error) {
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

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-2">
				<HealthBadge status={h.health_status} />
				{(h.reasons ?? []).length > 0 ? (
					<span className="text-xs text-muted-foreground">
						{(h.reasons ?? []).join(" · ").replace(/_/g, " ")}
					</span>
				) : (
					<span className="text-xs text-muted-foreground">No issues detected</span>
				)}
			</div>

			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{stats.map((s) => (
					<div key={s.label} className={ENTITY_CARD_BASE}>
						<div className="text-2xl font-semibold tabular-nums">{s.value}</div>
						<div className="text-xs text-muted-foreground">{s.label}</div>
					</div>
				))}
			</div>

			{h.last_error ? (
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
					<p className="text-sm text-destructive/90">{h.last_error}</p>
					<p className="text-xs text-muted-foreground">
						{[h.last_error_stage, h.last_error_outcome].filter(Boolean).join(" · ")} ·{" "}
						{relativeTime(h.last_error_at)}
					</p>
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
			<InfoCard icon={KeyRound} title="Slash commands">
				{supportsCommands
					? `Publish this agent's slash commands to ${meta.label}.`
					: `${meta.label} doesn't support slash commands.`}
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
							description="Command sync completed. The agent returned no commands to publish."
						/>
					) : null}
				</>
			) : null}
		</div>
	);
}
