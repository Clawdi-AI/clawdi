"use client";

import {
	ArrowDownLeft,
	ArrowUpRight,
	KeyRound,
	Link2,
	Link2Off,
	MessageSquareDashed,
	QrCode,
	RefreshCw,
	Smartphone,
	TerminalSquare,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { agentTypeLabel } from "@/components/dashboard/agent-label";
import { EmptyState } from "@/components/empty-state";
import { InfoCard } from "@/components/info-card";
import { PageHeader } from "@/components/page-header";
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
import { providerMeta } from "@/v2/channels/channel-providers";
import type {
	ChannelActivityItem,
	ChannelAgentLink,
	ChannelBinding,
} from "@/v2/channels/channel-types";
import {
	ChannelError,
	CopyInline,
	DeliveryBadge,
	HealthBadge,
	ProviderChip,
	TokenReveal,
} from "@/v2/channels/channel-ui";
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
	useRotateAgentToken,
	useSyncCommands,
	useUnlinkChannelAgent,
	useWhatsappTenantCreds,
} from "@/v2/channels/channels-hooks";
import { LinkAgentDialog } from "@/v2/channels/link-agent-dialog";

function formatWhen(iso: string | null | undefined): string {
	if (!iso) return "—";
	const delta = new Date(iso).getTime() - Date.now(); // positive = future
	const future = delta > 0;
	const phrase = (value: number, unit: string) =>
		future ? `in ${value}${unit}` : `${value}${unit} ago`;
	const min = Math.round(Math.abs(delta) / 60000);
	if (min < 1) return "just now";
	if (min < 60) return phrase(min, "m");
	const hr = Math.round(min / 60);
	if (hr < 24) return phrase(hr, "h");
	return new Date(iso).toLocaleDateString();
}

type EnvironmentList = ReturnType<typeof useEnvironments>["data"];

/** "machine · agent-type" label for an agent id, falling back to the raw id. */
function envName(envs: EnvironmentList, agentId: string): string {
	const env = envs?.find((e) => e.id === agentId);
	return env ? `${env.machine_name} · ${agentTypeLabel(env.agent_type)}` : agentId;
}

export function ChannelDetailPage() {
	const params = useParams<{ id: string }>();
	const id = params.id;
	const channel = useChannel(id);
	const health = useChannelHealth();
	const router = useRouter();
	const del = useDeleteChannel();

	useSetBreadcrumbTitle(channel.data?.name);

	const healthItem = useMemo(
		() => health.data?.items.find((h) => h.account_id === id),
		[health.data, id],
	);

	if (channel.isLoading) {
		return (
			<div data-v2="true" className="space-y-6 px-4 lg:px-6">
				<Skeleton className="h-12 w-64" />
				<Skeleton className="h-64 w-full rounded-lg" />
			</div>
		);
	}

	if (channel.error) {
		return (
			<div data-v2="true" className="px-4 lg:px-6">
				<ChannelError
					error={channel.error}
					onRetry={() => channel.refetch()}
					title="Couldn't load channel"
				/>
			</div>
		);
	}

	if (!channel.data) {
		return (
			<div data-v2="true" className="px-4 lg:px-6">
				<EmptyState
					icon={MessageSquareDashed}
					title="Channel not found"
					description="This channel may have been removed."
					action={
						<Button variant="outline" onClick={() => router.push("/channels")}>
							Back to Channels
						</Button>
					}
				/>
			</div>
		);
	}

	const ch = channel.data;
	const meta = providerMeta(ch.provider);

	return (
		<div data-v2="true" className="space-y-6 px-4 lg:px-6">
			<PageHeader
				title={ch.name}
				description={`${meta.label} · ${ch.visibility === "public" ? "Shared bot" : "Private bot"}`}
				actions={
					<ConfirmAction
						title={`Remove ${ch.name}?`}
						description={
							<p>
								Agents linked to this channel will stop sending and receiving. This can't be undone.
							</p>
						}
						confirmLabel="Remove channel"
						destructive
						onConfirm={() => del.mutate(id, { onSuccess: () => router.push("/channels") })}
					>
						<Button variant="outline" className="text-muted-foreground hover:text-destructive">
							<Trash2 className="size-4" />
							Remove
						</Button>
					</ConfirmAction>
				}
			/>

			<div className="flex items-center gap-3">
				<ProviderChip provider={ch.provider} />
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<span className="capitalize">{ch.status}</span>
					{healthItem ? <HealthBadge status={healthItem.health_status} /> : null}
				</div>
			</div>

			<Tabs defaultValue="agents">
				<TabsList className="flex-wrap">
					<TabsTrigger value="agents">Agents</TabsTrigger>
					{ch.provider === "whatsapp" ? (
						<TabsTrigger value="devices">Linked devices</TabsTrigger>
					) : null}
					<TabsTrigger value="pair">Pair code</TabsTrigger>
					<TabsTrigger value="bindings">Chats</TabsTrigger>
					<TabsTrigger value="activity">Activity</TabsTrigger>
					<TabsTrigger value="health">Health</TabsTrigger>
					<TabsTrigger value="commands">Commands</TabsTrigger>
				</TabsList>

				<TabsContent value="agents" className="mt-4">
					<AgentsTab accountId={id} accountName={ch.name} />
				</TabsContent>
				{ch.provider === "whatsapp" ? (
					<TabsContent value="devices" className="mt-4">
						<WhatsAppDevicesTab accountId={id} />
					</TabsContent>
				) : null}
				<TabsContent value="pair" className="mt-4">
					<PairCodeTab accountId={id} provider={ch.provider} />
				</TabsContent>
				<TabsContent value="bindings" className="mt-4">
					<BindingsTab accountId={id} />
				</TabsContent>
				<TabsContent value="activity" className="mt-4">
					<ActivityTab accountId={id} />
				</TabsContent>
				<TabsContent value="health" className="mt-4">
					<HealthTab accountId={id} />
				</TabsContent>
				<TabsContent value="commands" className="mt-4">
					<CommandsTab accountId={id} provider={ch.provider} />
				</TabsContent>
			</Tabs>
		</div>
	);
}

// ── Agents ───────────────────────────────────────────────────────────────────

function AgentsTab({ accountId, accountName }: { accountId: string; accountName: string }) {
	const links = useChannelAgentLinks(accountId);
	const envs = useEnvironments();
	const rotate = useRotateAgentToken(accountId);
	const unlink = useUnlinkChannelAgent(accountId);
	const [linkOpen, setLinkOpen] = useState(false);
	const [rotated, setRotated] = useState<Record<string, string>>({});

	if (links.isLoading) return <Skeleton className="h-24 w-full rounded-lg" />;
	if (links.error) {
		return (
			<ChannelError
				error={links.error}
				onRetry={() => links.refetch()}
				title="Couldn't load linked agents"
			/>
		);
	}
	const items = links.data ?? [];

	return (
		<div className="space-y-3">
			{envs.error ? (
				<ChannelError
					error={envs.error}
					onRetry={() => envs.refetch()}
					title="Couldn't load agent names"
				/>
			) : null}
			<div className="flex justify-end">
				<Button size="sm" onClick={() => setLinkOpen(true)}>
					<Link2 className="size-3.5" />
					Link an agent
				</Button>
			</div>

			{items.length === 0 ? (
				<EmptyState
					icon={Link2}
					title="No agents linked"
					description="Link an agent so it can send and receive on this channel."
					fillHeight={false}
				/>
			) : (
				<div className="space-y-2">
					{items.map((link: ChannelAgentLink) => (
						<div key={link.id} className="rounded-lg border p-3">
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0">
									<div className="truncate text-sm font-medium">
										{envName(envs.data, link.agent_id)}
									</div>
									<div className="text-xs capitalize text-muted-foreground">
										{link.status} · linked {formatWhen(link.created_at)}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									<Button
										variant="outline"
										size="sm"
										// Per-row: only the acting row's button shows pending, not all.
										disabled={rotate.isPending && rotate.variables === link.id}
										onClick={() =>
											rotate.mutate(link.id, {
												onSuccess: (data) => {
													const token = data.agent_token;
													if (!token) return;
													setRotated((prev) => ({
														...prev,
														[link.id]: token,
													}));
												},
											})
										}
									>
										{rotate.isPending && rotate.variables === link.id ? (
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
										onConfirm={() => unlink.mutate(link.id)}
									>
										<Button
											variant="ghost"
											size="icon-sm"
											className="text-muted-foreground hover:text-destructive"
											disabled={unlink.isPending && unlink.variables === link.id}
											aria-label="Unlink agent"
										>
											<Link2Off className="size-4" />
										</Button>
									</ConfirmAction>
								</div>
							</div>
							{rotated[link.id] ? (
								<div className="mt-3">
									<TokenReveal
										label="New agent token"
										value={rotated[link.id]}
										note="The previous token is now invalid. Update the agent with this value."
									/>
								</div>
							) : null}
						</div>
					))}
				</div>
			)}

			<LinkAgentDialog
				open={linkOpen}
				onOpenChange={setLinkOpen}
				accountId={accountId}
				accountName={accountName}
			/>
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
	const [linkId, setLinkId] = useState("");

	const linkItems = links.data ?? [];
	const devices = creds.data ?? [];
	// Default to the only link when there's exactly one.
	const effectiveLink = linkId || (linkItems.length === 1 ? linkItems[0].id : "");

	return (
		<div className="max-w-xl space-y-4">
			<InfoCard icon={Smartphone} title="Link a WhatsApp number">
				WhatsApp uses no bot token. Mint a device credential for an agent, then finish the link by
				scanning it in WhatsApp → Linked devices. The live in-dashboard QR is coming soon — for now
				the credential is handed to the agent runtime to complete pairing.
			</InfoCard>

			{links.isLoading ? (
				<Skeleton className="h-16 w-full rounded-lg" />
			) : links.error ? (
				<ChannelError
					error={links.error}
					onRetry={() => links.refetch()}
					title="Couldn't load linked agents"
				/>
			) : linkItems.length === 0 ? (
				<EmptyState
					bordered
					fillHeight={false}
					title="Link an agent first"
					description="A WhatsApp device is minted per agent. Link an agent on the Agents tab, then come back."
				/>
			) : (
				<div className="space-y-2">
					{envs.error ? (
						<ChannelError
							error={envs.error}
							onRetry={() => envs.refetch()}
							title="Couldn't load agent names"
						/>
					) : null}
					{linkItems.length > 1 ? (
						<div className="space-y-1.5">
							<Label htmlFor="wa-agent">Agent</Label>
							<Select value={effectiveLink} onValueChange={setLinkId}>
								<SelectTrigger id="wa-agent">
									<SelectValue placeholder="Choose an agent" />
								</SelectTrigger>
								<SelectContent>
									{linkItems.map((l) => (
										<SelectItem key={l.id} value={l.id}>
											{envName(envs.data, l.agent_id)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : null}
					<Button
						onClick={() => effectiveLink && create.mutate({ agent_link_id: effectiveLink })}
						disabled={!effectiveLink || create.isPending}
					>
						<Smartphone className="size-4" />
						{create.isPending ? "Minting…" : "Link a device"}
					</Button>
				</div>
			)}

			<div className="space-y-2">
				<div className="text-sm font-medium">Linked devices</div>
				{creds.isLoading ? (
					<Skeleton className="h-16 w-full rounded-lg" />
				) : creds.error ? (
					<ChannelError
						error={creds.error}
						onRetry={() => creds.refetch()}
						title="Couldn't load linked devices"
					/>
				) : devices.length === 0 ? (
					<div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
						No devices linked yet.
					</div>
				) : (
					devices.map((d) => (
						<div
							key={d.credential_id}
							className="flex items-center justify-between gap-3 rounded-lg border p-3"
						>
							<div className="min-w-0">
								{d.jid ? (
									<div className="truncate font-mono text-xs">{d.jid}</div>
								) : (
									<div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
										<Spinner className="size-3" />
										Pending pairing
									</div>
								)}
								<div className="text-xs text-muted-foreground">
									{envName(envs.data, d.agent_id)} · added {formatWhen(d.created_at)}
								</div>
							</div>
							<ConfirmAction
								title="Unlink this device?"
								description={<p>The WhatsApp credential is revoked. This can't be undone.</p>}
								confirmLabel="Unlink"
								destructive
								onConfirm={() => revoke.mutate(d.credential_id)}
							>
								<Button
									variant="ghost"
									size="icon-sm"
									className="text-muted-foreground hover:text-destructive"
									disabled={revoke.isPending}
									aria-label="Unlink device"
								>
									<Trash2 className="size-4" />
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

function PairCodeTab({ accountId, provider }: { accountId: string; provider: string }) {
	const envs = useEnvironments();
	const create = useCreatePairCode(accountId);
	// "" = no agent chosen (use the channel's linked agent). Sentinel keeps the
	// Select controlled; mapped back to undefined in the request below.
	const [agentId, setAgentId] = useState("");
	const [ttl, setTtl] = useState("900");
	const [result, setResult] = useState<{ code: string; expires_at: string } | null>(null);
	const meta = providerMeta(provider);

	function generate() {
		create.mutate(
			{ agent_id: agentId || undefined, ttl_seconds: Number(ttl) },
			{ onSuccess: (data) => setResult({ code: data.code, expires_at: data.expires_at }) },
		);
	}

	return (
		<div className="max-w-xl space-y-4">
			<InfoCard icon={QrCode} title="Pair a chat">
				Generate a one-time code, then send it from the {meta.label} chat you want to pair — the
				agent links that conversation when it sees the code.
			</InfoCard>

			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="pair-agent">Agent</Label>
					{envs.isLoading ? (
						<Skeleton className="h-10 w-full rounded-md" />
					) : (
						<Select value={agentId} onValueChange={setAgentId} disabled={!!envs.error}>
							<SelectTrigger id="pair-agent">
								<SelectValue placeholder="Use linked agent" />
							</SelectTrigger>
							<SelectContent>
								{(envs.data ?? []).map((env) => (
									<SelectItem key={env.id} value={env.id}>
										{env.machine_name} · {agentTypeLabel(env.agent_type)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="pair-ttl">Expires in</Label>
					<Select value={ttl} onValueChange={setTtl}>
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
				<ChannelError
					error={envs.error}
					onRetry={() => envs.refetch()}
					title="Couldn't load agents"
				/>
			) : null}

			<Button onClick={generate} disabled={create.isPending}>
				<QrCode className="size-4" />
				{create.isPending ? "Generating…" : "Generate pairing code"}
			</Button>

			{result ? (
				<div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
					<div className="text-xs font-medium text-primary">Pairing code</div>
					<div className="font-mono text-3xl font-semibold tracking-[0.2em]">{result.code}</div>
					<p className="text-sm text-muted-foreground">
						Send <span className="font-mono font-medium">{result.code}</span> from the chat you want
						to pair. Expires {formatWhen(result.expires_at)}.
					</p>
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
			<ChannelError
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
		<div className="space-y-2">
			{items.map((b: ChannelBinding) => (
				<div key={b.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{b.external_chat_name ?? "Chat"}</div>
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<span className="capitalize">{b.external_chat_type ?? "chat"}</span>
							<span>·</span>
							<CopyInline value={b.external_chat_id} />
						</div>
					</div>
					<span className="text-xs capitalize text-muted-foreground">{b.status}</span>
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
			<ChannelError
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
		<div className="space-y-2">
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
		<div className="flex items-start gap-3 rounded-lg border p-3">
			<span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
				{isEvent ? (
					<TerminalSquare className="size-3.5" />
				) : inbound ? (
					<ArrowDownLeft className="size-3.5" />
				) : (
					<ArrowUpRight className="size-3.5" />
				)}
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium capitalize">
						{isEvent ? (item.stage ?? "event") : inbound ? "Inbound" : "Outbound"}
					</span>
					{item.delivery_status ? <DeliveryBadge status={item.delivery_status} /> : null}
					<span className="ml-auto shrink-0 text-xs text-muted-foreground">
						{formatWhen(item.created_at)}
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
						<CopyInline value={item.external_chat_id} />
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
			<ChannelError
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

	return (
		<div className="space-y-4">
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
					<div key={s.label} className="rounded-lg border p-3">
						<div className="text-2xl font-semibold tabular-nums">{s.value}</div>
						<div className="text-xs text-muted-foreground">{s.label}</div>
					</div>
				))}
			</div>

			{h.last_error ? (
				<div className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
					<div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
						<TriangleAlert className="size-4" />
						Last error
					</div>
					<p className="text-sm text-destructive/90">{h.last_error}</p>
					<p className="text-xs text-muted-foreground">
						{[h.last_error_stage, h.last_error_outcome].filter(Boolean).join(" · ")} ·{" "}
						{formatWhen(h.last_error_at)}
					</p>
				</div>
			) : null}

			{h.native_transport ? (
				<div className="rounded-lg border p-3">
					<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Native transport
					</div>
					<pre className="overflow-x-auto text-xs text-muted-foreground">
						{JSON.stringify(h.native_transport, null, 2)}
					</pre>
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

	return (
		<div className="max-w-xl space-y-4">
			<InfoCard icon={KeyRound} title="Slash commands">
				{supportsCommands
					? `Publish this agent's slash commands to ${meta.label}.`
					: `${meta.label} doesn't support slash commands.`}
			</InfoCard>

			{supportsCommands ? (
				<>
					<Button onClick={() => sync.mutate()} disabled={sync.isPending}>
						<RefreshCw className="size-4" />
						{sync.isPending ? "Syncing…" : "Sync commands"}
					</Button>
					{commands.length > 0 ? (
						<div className="space-y-2 rounded-lg border p-3">
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
						<div className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
							Command sync completed. The runtime returned no commands to publish.
						</div>
					) : null}
				</>
			) : null}
		</div>
	);
}
