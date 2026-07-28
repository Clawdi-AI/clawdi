"use client";

import { type ShouldBlockFn, useBlocker, useRouter } from "@tanstack/react-router";
import {
	ArrowDownLeft,
	ArrowUpRight,
	Check,
	Copy,
	Eye,
	EyeOff,
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
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
	acknowledgeRotatedToken,
	hasAtRiskRotatedToken,
	nativeTransportSummary,
	pairCodeRequiresExplicitAgent,
	type RotatedTokenDisplayState,
	rotatedTokenDisplayState,
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
	TokenReveal,
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
	useEnvironments,
	useRevokeWhatsappTenantCred,
	useSyncCommands,
	useUnlinkChannelAgent,
	useWhatsappTenantCreds,
} from "@/hosted/v2/channels/channels-hooks";
import { LinkAgentDialog } from "@/hosted/v2/channels/link-agent-dialog";
import {
	pairingCommand,
	WHATSAPP_COMING_SOON_MESSAGE,
	WHATSAPP_LINKING_READY,
} from "@/hosted/v2/channels/link-agent-dialog.logic";
import {
	type AgentOwnership,
	agentOwnershipKindFromId,
	useAgentOwnership,
} from "@/lib/agent-ownership";
import { toastApiError, unwrap, useApi } from "@/lib/api";
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

export function ChannelDetailPage({ channelId: id }: { channelId: string }) {
	const channel = useChannel(id);
	const health = useChannelHealth();
	const rotatedTokens = useRotatedTokenLifecycle(id);
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
				rotatedTokens.discardAtRiskToken();
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
						description={`Agents linked to this channel will stop sending and receiving. This can't be undone.${rotatedTokens.hasTokenAtRisk ? " The one-time token shown here will also be discarded." : ""}`}
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

			<Tabs defaultValue="agents" className="min-w-0">
				<TabsList className="h-auto flex-wrap justify-start">
					<TabsTrigger value="agents">Agents</TabsTrigger>
					{ch.provider === "whatsapp" && !providerUnavailable ? (
						<TabsTrigger value="devices">Linked devices</TabsTrigger>
					) : null}
					{providerUnavailable ? null : <TabsTrigger value="pair">Pair code</TabsTrigger>}
					<TabsTrigger value="bindings">Chats</TabsTrigger>
					<TabsTrigger value="activity">Activity</TabsTrigger>
					<TabsTrigger value="health">Health</TabsTrigger>
					{providerUnavailable ? null : <TabsTrigger value="commands">Commands</TabsTrigger>}
				</TabsList>

				<TabsContent value="agents" className={LIST_TAB_CLASS}>
					<AgentsTab
						accountId={id}
						accountName={ch.name}
						provider={ch.provider}
						readOnly={providerUnavailable}
						rotatedTokens={rotatedTokens}
					/>
				</TabsContent>
				{ch.provider === "whatsapp" && !providerUnavailable ? (
					<TabsContent value="devices" className={FORM_TAB_CLASS}>
						<WhatsAppDevicesTab accountId={id} />
					</TabsContent>
				) : null}
				{providerUnavailable ? null : (
					<TabsContent value="pair" className={FORM_TAB_CLASS}>
						<PairCodeTab accountId={id} provider={ch.provider} />
					</TabsContent>
				)}
				<TabsContent value="bindings" className={LIST_TAB_CLASS}>
					<BindingsTab accountId={id} />
				</TabsContent>
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
			<RotatedTokenNavigationAlert lifecycle={rotatedTokens} />
		</div>
	);
}

// ── Agents ───────────────────────────────────────────────────────────────────

function RotatedTokenCard({
	state,
	onAcknowledge,
}: {
	state: RotatedTokenDisplayState;
	onAcknowledge: () => void;
}) {
	const [revealed, setRevealed] = useState(false);
	const [copied, setCopied] = useState(false);
	const tokenIdentity = state.status === "available" ? state.token : null;

	useEffect(() => {
		setRevealed(false);
		setCopied(false);
	}, [tokenIdentity]);

	if (state.status === "unrecoverable") {
		return (
			<div
				role="alert"
				className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
			>
				<TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
				<div className="space-y-1">
					<p className="text-xs font-medium text-destructive">New token is not recoverable</p>
					<p className="text-xs text-muted-foreground">
						This token was shown once and is not recoverable — rotate again to get a new one.
					</p>
				</div>
			</div>
		);
	}
	const token = state.token;

	async function copyToken() {
		try {
			await navigator.clipboard.writeText(token);
			setCopied(true);
			onAcknowledge();
			toast.success("Token copied to clipboard");
			window.setTimeout(() => setCopied(false), 1_500);
		} catch {
			toast.error("Couldn’t copy — select and copy manually.");
		}
	}

	return (
		<div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
			<div className="text-xs font-medium text-primary">New agent token</div>
			<div className="flex items-center gap-2">
				<code className="flex-1 break-all rounded bg-muted px-3 py-2 font-mono text-xs">
					{revealed ? state.token : "••••••••••••"}
				</code>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={() => setRevealed((visible) => !visible)}
					aria-label={`${revealed ? "Hide" : "Show"} New agent token`}
					aria-pressed={revealed}
				>
					{revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={() => void copyToken()}
					aria-label="Copy New agent token"
				>
					{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				{state.acknowledged
					? "This token is shown only once and cannot be recovered later. If you lose it, rotate again to get a new one."
					: "Shown only once. Copy it or confirm you saved it before leaving this page; it cannot be recovered later."}
			</p>
			{state.acknowledged ? null : (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="self-start"
					onClick={onAcknowledge}
				>
					I’ve saved this token
				</Button>
			)}
		</div>
	);
}

function useRotatedTokenLifecycle(accountId: string) {
	const api = useApi();
	const [rotated, setRotated] = useState<Record<string, RotatedTokenDisplayState>>({});
	const rotationControllersRef = useRef<Map<string, AbortController>>(new Map());
	const rotatingLinksRef = useRef<Set<string>>(new Set());
	const [rotatingLinks, setRotatingLinks] = useState<ReadonlySet<string>>(() => new Set());
	const hasTokenAtRisk = hasAtRiskRotatedToken(rotated, rotatingLinks.size > 0);
	const tokenAtRiskRef = useRef(hasTokenAtRisk);
	tokenAtRiskRef.current = hasTokenAtRisk;
	const shouldBlockNavigation: ShouldBlockFn = useCallback(
		({ current, next }) =>
			tokenAtRiskRef.current && current.pathname.toLowerCase() !== next.pathname.toLowerCase(),
		[],
	);
	const shouldBlockDocumentExit = useCallback(() => tokenAtRiskRef.current, []);
	const blocker = useBlocker({
		shouldBlockFn: shouldBlockNavigation,
		enableBeforeUnload: shouldBlockDocumentExit,
		withResolver: true,
	});

	useEffect(() => {
		setRotated({});
		setRotatingLinks(new Set());
		rotatingLinksRef.current.clear();
		return () => {
			for (const controller of rotationControllersRef.current.values()) controller.abort();
			rotationControllersRef.current.clear();
		};
	}, [accountId]);

	async function rotateToken(linkId: string) {
		if (rotatingLinksRef.current.has(linkId)) return;
		rotatingLinksRef.current.add(linkId);
		tokenAtRiskRef.current = true;
		setRotatingLinks((prev) => new Set(prev).add(linkId));
		setRotated((prev) => {
			const next = { ...prev };
			delete next[linkId];
			return next;
		});
		const controller = new AbortController();
		rotationControllersRef.current.set(linkId, controller);
		try {
			const data = unwrap(
				await api.POST("/v1/channels/{account_id}/agent-links/{link_id}/token", {
					params: { path: { account_id: accountId, link_id: linkId } },
					signal: controller.signal,
				}),
			);
			const state = rotatedTokenDisplayState(data.agent_token);
			setRotated((prev) => ({ ...prev, [linkId]: state }));
			toast.success("Token rotated", {
				description:
					state.status === "available"
						? "Copy the new token below — the previous one is now invalid."
						: "The previous token is now invalid. Rotate again to receive a new token.",
			});
		} catch (error) {
			if (controller.signal.aborted) return;
			setRotated((prev) => ({ ...prev, [linkId]: { status: "unrecoverable" } }));
			toastApiError("Couldn’t rotate token")(error);
		} finally {
			rotationControllersRef.current.delete(linkId);
			rotatingLinksRef.current.delete(linkId);
			setRotatingLinks((prev) => {
				const next = new Set(prev);
				next.delete(linkId);
				return next;
			});
		}
	}

	function acknowledgeToken(linkId: string) {
		setRotated((prev) => {
			const state = prev[linkId];
			return state ? { ...prev, [linkId]: acknowledgeRotatedToken(state) } : prev;
		});
	}

	function discardAtRiskToken() {
		tokenAtRiskRef.current = false;
		for (const controller of rotationControllersRef.current.values()) controller.abort();
		rotationControllersRef.current.clear();
		rotatingLinksRef.current.clear();
		setRotatingLinks(new Set());
		setRotated((prev) =>
			Object.fromEntries(Object.keys(prev).map((linkId) => [linkId, { status: "unrecoverable" }])),
		);
	}

	function leaveWithoutToken() {
		discardAtRiskToken();
		if (blocker.status === "blocked") blocker.proceed();
	}

	return {
		acknowledgeToken,
		blocker,
		discardAtRiskToken,
		hasTokenAtRisk,
		leaveWithoutToken,
		rotated,
		rotateToken,
		rotatingLinks,
	};
}

type RotatedTokenLifecycle = ReturnType<typeof useRotatedTokenLifecycle>;

function RotatedTokenNavigationAlert({ lifecycle }: { lifecycle: RotatedTokenLifecycle }) {
	const { blocker, leaveWithoutToken, rotatingLinks } = lifecycle;
	return (
		<AlertDialog
			open={blocker.status === "blocked"}
			onOpenChange={(open) => {
				if (!open && blocker.status === "blocked") blocker.reset();
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{rotatingLinks.size > 0
							? "Leave while token rotation is in progress?"
							: "Leave without saving the new token?"}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{rotatingLinks.size > 0
							? "The one-time token may be returned after this page closes. If you leave, it could be lost and cannot be recovered — rotate again to get a new one."
							: "This token is shown only once and has not been copied or acknowledged. If you leave, it will be lost. This token was shown once and is not recoverable — rotate again to get a new one."}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Stay and copy token</AlertDialogCancel>
					<AlertDialogAction variant="destructive" onClick={leaveWithoutToken}>
						Leave and lose token
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function AgentsTab({
	accountId,
	accountName,
	provider,
	readOnly = false,
	rotatedTokens,
}: {
	accountId: string;
	accountName: string;
	provider: string;
	readOnly?: boolean;
	rotatedTokens: RotatedTokenLifecycle;
}) {
	const links = useChannelAgentLinks(accountId);
	const envs = useEnvironments();
	const unlink = useUnlinkChannelAgent(accountId);
	const [linkOpen, setLinkOpen] = useState(false);
	const { acknowledgeToken, rotateToken, rotated, rotatingLinks } = rotatedTokens;
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
						const isRotating = rotatingLinks.has(link.id);
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
											<Button
												variant="outline"
												size="sm"
												// Per-row: only the acting row's button shows pending, not all.
												disabled={isRotating}
												onClick={() => rotateToken(link.id)}
											>
												{isRotating ? (
													<Spinner className="size-3.5" />
												) : (
													<RefreshCw className="size-3.5" />
												)}
												Rotate token
											</Button>
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
								{rotated[link.id] ? (
									<div className="mt-3">
										<RotatedTokenCard
											state={rotated[link.id]}
											onAcknowledge={() => acknowledgeToken(link.id)}
										/>
									</div>
								) : null}
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
	code: string;
	expires_at: string;
	agent_link_id: string;
};

type RevealedAgentToken = {
	agentLinkId: string;
	value: string;
};

function isExpired(expiresAt: string, nowMs: number): boolean {
	const expiresAtMs = new Date(expiresAt).getTime();
	return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

function PairCodeTab({ accountId, provider }: { accountId: string; provider: string }) {
	const envs = useEnvironments();
	const links = useChannelAgentLinks(accountId);
	const create = useCreatePairCode(accountId);
	const ownership = useAgentOwnership();
	// "" = no agent chosen (use the channel's linked agent). Sentinel keeps the
	// Select controlled; mapped back to undefined in the request below.
	const [agentId, setAgentId] = useState("");
	const [ttl, setTtl] = useState("900");
	const [result, setResult] = useState<PairCodeResult | null>(null);
	const [revealedAgentToken, setRevealedAgentToken] = useState<RevealedAgentToken | null>(null);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [generating, setGenerating] = useState(false);
	const agentItems = (envs.data ?? []).map((env) => ({
		value: env.id,
		label: envName(envs.data, env.id, ownership),
	}));
	const generateLocked = useRef(false);
	const meta = providerMeta(provider);
	const isGenerating = generating || create.isPending;
	const linkedAgentCount = links.data?.length ?? 0;
	const requiresExplicitAgent = pairCodeRequiresExplicitAgent(linkedAgentCount);
	const selectionMessage =
		requiresExplicitAgent && !agentId && !links.isLoading && !links.error
			? linkedAgentCount === 0
				? agentItems.length === 0
					? "No linked agent is available. Link an agent in the Agents tab first."
					: "No agent is linked. Choose an agent for this pairing code."
				: "This channel has multiple linked agents. Choose the agent for this pairing code."
			: null;
	const canGenerate =
		!isGenerating &&
		!links.isLoading &&
		!links.error &&
		(!requiresExplicitAgent || (!envs.isLoading && !envs.error && Boolean(agentId)));
	const visibleAgentToken =
		result && revealedAgentToken?.agentLinkId === result.agent_link_id
			? revealedAgentToken.value
			: null;
	const resultExpired = result ? isExpired(result.expires_at, nowMs) : false;

	useEffect(() => {
		if (!result) return;
		setNowMs(Date.now());
		const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(interval);
	}, [result]);

	function generate() {
		if (!canGenerate || generateLocked.current) return;
		generateLocked.current = true;
		setGenerating(true);
		setResult(null);
		void (async () => {
			try {
				const data = await create.execute({
					agent_id: agentId || undefined,
					ttl_seconds: Number(ttl),
				});
				if (data.agent_token) {
					setRevealedAgentToken({
						agentLinkId: data.agent_link_id,
						value: data.agent_token,
					});
				}
				setResult({
					code: data.code,
					expires_at: data.expires_at,
					agent_link_id: data.agent_link_id,
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
			<InfoCard icon={QrCode} title="Pair a chat">
				Generate a one-time code, then send it from the {meta.label} chat you want to pair — the
				agent links that conversation when it sees the code.
			</InfoCard>

			<div className="grid gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="pair-agent">Agent</Label>
					{envs.isLoading || links.isLoading ? (
						<Skeleton className="h-10 w-full rounded-md" />
					) : (
						<Select
							items={agentItems}
							value={agentId}
							onValueChange={(value) => {
								if (value !== null) setAgentId(value);
							}}
							disabled={Boolean(envs.error || links.error) || isGenerating}
						>
							<SelectTrigger
								id="pair-agent"
								aria-describedby={selectionMessage ? "pair-agent-requirement" : undefined}
							>
								<SelectValue
									placeholder={requiresExplicitAgent ? "Choose an agent" : "Use linked agent"}
								/>
							</SelectTrigger>
							<SelectContent>
								{(envs.data ?? []).map((env) => (
									<SelectItem
										key={env.id}
										value={env.id}
										label={envName(envs.data, env.id, ownership)}
									>
										<AgentName env={env} fallback={env.id} />
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
				{isGenerating ? "Generating…" : "Generate pairing code"}
			</Button>

			{result ? (
				<div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
					<div className="text-xs font-medium text-primary">Pairing code</div>
					<div className="font-mono text-3xl font-semibold tracking-[0.2em]">{result.code}</div>
					<p className="text-sm text-muted-foreground">
						{resultExpired ? (
							"Expired. Generate a new code."
						) : (
							<>
								Send <span className="font-mono font-medium">{pairingCommand(result.code)}</span>{" "}
								from the chat you want to pair. Expires {relativeTime(result.expires_at)}.
							</>
						)}
					</p>
					{visibleAgentToken ? (
						<TokenReveal
							label="Agent token"
							value={visibleAgentToken}
							note="Copy it now. It won't be shown again. The agent uses it to send and receive on this channel."
						/>
					) : null}
				</div>
			) : null}
		</div>
	);
}

// ── Bindings (paired chats) ──────────────────────────────────────────────────

function BindingsTab({ accountId }: { accountId: string }) {
	const bindings = useChannelBindings(accountId);
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
			{items.map((b: ChannelBinding) => (
				<div key={b.id} className={cn(ENTITY_CARD_BASE, "flex items-center gap-3")}>
					<EntityHeader
						className="min-w-0 flex-1"
						icon={
							<IconChip size="sm">
								<MessageSquareDashed />
							</IconChip>
						}
						title={b.external_chat_name ?? "Chat"}
						meta={[
							<span key="type" className="capitalize">
								{b.external_chat_type ?? "chat"}
							</span>,
							<CopyInline key="chat-id" value={b.external_chat_id} label="chat ID" />,
						]}
					/>
					<ChannelStatusBadge status={b.status} />
				</div>
			))}
		</div>
	);
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
