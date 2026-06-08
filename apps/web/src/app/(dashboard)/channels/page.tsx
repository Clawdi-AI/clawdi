"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Bot,
	Check,
	Copy,
	KeyRound,
	Link as LinkIcon,
	MessageSquare,
	Plus,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AgentLabel, agentTypeLabel, cleanMachineName } from "@/components/dashboard/agent-label";
import {
	DashboardEmptyLine,
	DashboardSection,
	DashboardSectionHeader,
} from "@/components/dashboard/section";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { unwrap, useApi } from "@/lib/api";
import type {
	ChannelAccount,
	ChannelAccountCreate,
	ChannelAccountCreated,
	ChannelAgentLink,
	ChannelBinding,
	ChannelPairCode,
	Environment,
} from "@/lib/api-schemas";
import { cn, errorMessage, formatAbsoluteTooltip, relativeTime } from "@/lib/utils";

type ChannelProvider = ChannelAccountCreate["provider"];

const PROVIDERS = [
	{ value: "telegram", label: "Telegram" },
	{ value: "discord", label: "Discord" },
	{ value: "whatsapp", label: "WhatsApp" },
	{ value: "imessage", label: "iMessage" },
] as const satisfies readonly { value: ChannelProvider; label: string }[];

const NO_AGENT = "none";
const DEFAULT_TTL_SECONDS = 900;

export default function ChannelsPage() {
	const api = useApi();
	const queryClient = useQueryClient();
	const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [linkOpen, setLinkOpen] = useState(false);
	const [createdChannel, setCreatedChannel] = useState<ChannelAccountCreated | null>(null);
	const [latestAgentToken, setLatestAgentToken] = useState<ChannelAgentLink | null>(null);
	const [pairCode, setPairCode] = useState<ChannelPairCode | null>(null);

	const channelsQuery = useQuery({
		queryKey: ["channels"],
		queryFn: async () => unwrap(await api.GET("/api/channels")),
	});
	const agentsQuery = useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
	});

	const channels = channelsQuery.data ?? [];
	const agents = agentsQuery.data ?? [];
	const selectedChannel =
		channels.find((channel) => channel.id === selectedChannelId) ?? channels[0] ?? null;

	const linksQuery = useQuery({
		queryKey: ["channels", selectedChannel?.id, "agent-links"],
		enabled: !!selectedChannel,
		queryFn: async () =>
			unwrap(
				await api.GET("/api/channels/{account_id}/agent-links", {
					params: { path: { account_id: selectedChannel?.id ?? "" } },
				}),
			),
	});
	const bindingsQuery = useQuery({
		queryKey: ["channels", selectedChannel?.id, "bindings"],
		enabled: !!selectedChannel,
		queryFn: async () =>
			unwrap(
				await api.GET("/api/channels/{account_id}/bindings", {
					params: { path: { account_id: selectedChannel?.id ?? "" } },
				}),
			),
	});

	useEffect(() => {
		if (channels.length === 0) {
			if (selectedChannelId) setSelectedChannelId(null);
			return;
		}
		if (!selectedChannelId || !channels.some((channel) => channel.id === selectedChannelId)) {
			setSelectedChannelId(channels[0]?.id ?? null);
		}
	}, [channels, selectedChannelId]);

	const createChannel = useMutation({
		mutationFn: async (body: ChannelAccountCreate) =>
			unwrap(await api.POST("/api/channels", { body })),
		onSuccess: async (created) => {
			setCreatedChannel(created);
			setSelectedChannelId(created.id);
			await queryClient.invalidateQueries({ queryKey: ["channels"] });
			if (created.agent_link_id) {
				await queryClient.invalidateQueries({ queryKey: ["channels", created.id, "agent-links"] });
			}
			toast.success("Channel Created", { description: created.name });
		},
		onError: (e) => toast.error("Failed to Create Channel", { description: errorMessage(e) }),
	});

	const linkAgent = useMutation({
		mutationFn: async ({ accountId, agentId }: { accountId: string; agentId: string }) =>
			unwrap(
				await api.POST("/api/channels/{account_id}/agent-links", {
					params: { path: { account_id: accountId } },
					body: { agent_id: agentId },
				}),
			),
		onSuccess: async (link) => {
			setLatestAgentToken(link);
			setLinkOpen(false);
			await queryClient.invalidateQueries({
				queryKey: ["channels", link.account_id, "agent-links"],
			});
			toast.success("Agent Linked", { description: agentLabel(agentsById(agents), link.agent_id) });
		},
		onError: (e) => toast.error("Failed to Link Agent", { description: errorMessage(e) }),
	});

	const createPairCode = useMutation({
		mutationFn: async ({ accountId, linkId }: { accountId: string; linkId: string }) =>
			unwrap(
				await api.POST("/api/channels/{account_id}/pair-codes", {
					params: { path: { account_id: accountId } },
					body: {
						agent_id: null,
						agent_link_id: linkId,
						ttl_seconds: DEFAULT_TTL_SECONDS,
					},
				}),
			),
		onSuccess: (created) => {
			setPairCode(created);
			toast.success("Pair Code Created", { description: `/bot_pair ${created.code}` });
		},
		onError: (e) => toast.error("Failed to Create Pair Code", { description: errorMessage(e) }),
	});

	const deleteChannel = useMutation({
		mutationFn: async (accountId: string) =>
			unwrap(
				await api.DELETE("/api/channels/{account_id}", {
					params: { path: { account_id: accountId } },
				}),
			),
		onSuccess: async (_result, accountId) => {
			if (selectedChannelId === accountId) setSelectedChannelId(null);
			await queryClient.invalidateQueries({ queryKey: ["channels"] });
			toast.success("Channel Removed");
		},
		onError: (e) => toast.error("Failed to Remove Channel", { description: errorMessage(e) }),
	});

	const links = linksQuery.data ?? [];
	const bindings = bindingsQuery.data ?? [];
	const agentMap = useMemo(() => agentsById(agents), [agents]);

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Channels"
				description="Connect Telegram, Discord, WhatsApp, or iMessage bots to agents."
				actions={
					<CreateChannelDialog
						open={createOpen}
						onOpenChange={(open) => {
							setCreateOpen(open);
							if (!open) setCreatedChannel(null);
						}}
						agents={agents}
						isLoadingAgents={agentsQuery.isLoading}
						createdChannel={createdChannel}
						isSubmitting={createChannel.isPending}
						onSubmit={(body) => createChannel.mutate(body)}
					/>
				}
			/>

			<div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.45fr)]">
				<DashboardSection className="min-w-0 self-start">
					<DashboardSectionHeader
						icon={Bot}
						title="Bots"
						count={channels.length}
						description="Public bots are preconfigured by Clawdi; private bots are owned by your account."
					/>
					<ChannelList
						channels={channels}
						isLoading={channelsQuery.isLoading}
						selectedChannelId={selectedChannel?.id ?? null}
						onSelect={(channel) => {
							setSelectedChannelId(channel.id);
							setPairCode(null);
							setLatestAgentToken(null);
						}}
					/>
				</DashboardSection>

				<DashboardSection className="min-w-0">
					{selectedChannel ? (
						<>
							<DashboardSectionHeader
								icon={MessageSquare}
								title={selectedChannel.name}
								description={
									<span className="flex flex-wrap items-center gap-2">
										<ProviderBadge provider={selectedChannel.provider} />
										<VisibilityBadge visibility={selectedChannel.visibility} />
										<span>{selectedChannel.status}</span>
									</span>
								}
								toolbar={
									<div className="flex flex-wrap gap-2">
										<LinkAgentDialog
											open={linkOpen}
											onOpenChange={setLinkOpen}
											agents={agents}
											linkedAgentIds={new Set(links.map((link) => link.agent_id))}
											isLoadingAgents={agentsQuery.isLoading}
											isSubmitting={linkAgent.isPending}
											onSubmit={(agentId) =>
												linkAgent.mutate({ accountId: selectedChannel.id, agentId })
											}
										/>
										{selectedChannel.visibility === "private" ? (
											<ConfirmAction
												title="Remove channel?"
												description={
													<p>Existing pairings and channel credentials will be removed.</p>
												}
												confirmLabel="Remove"
												destructive
												onConfirm={() => deleteChannel.mutate(selectedChannel.id)}
											>
												<Button variant="outline" size="sm" disabled={deleteChannel.isPending}>
													<Trash2 />
													Remove
												</Button>
											</ConfirmAction>
										) : null}
									</div>
								}
							/>
							<ChannelDetail
								channel={selectedChannel}
								links={links}
								bindings={bindings}
								agentMap={agentMap}
								isLoadingLinks={linksQuery.isLoading}
								isLoadingBindings={bindingsQuery.isLoading}
								pairCode={pairCode}
								latestAgentToken={latestAgentToken}
								isCreatingPairCode={createPairCode.isPending}
								onCreatePairCode={(linkId) =>
									createPairCode.mutate({ accountId: selectedChannel.id, linkId })
								}
							/>
						</>
					) : (
						<EmptyState
							icon={Bot}
							title="No channels yet"
							description="Create a private bot or use a public bot after an administrator publishes one."
							action={
								<Button onClick={() => setCreateOpen(true)}>
									<Plus />
									Create Channel
								</Button>
							}
							bordered
						/>
					)}
				</DashboardSection>
			</div>
		</div>
	);
}

function ChannelList({
	channels,
	isLoading,
	selectedChannelId,
	onSelect,
}: {
	channels: ChannelAccount[];
	isLoading: boolean;
	selectedChannelId: string | null;
	onSelect: (channel: ChannelAccount) => void;
}) {
	if (isLoading) {
		return (
			<div className="space-y-3 p-4">
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-10 w-2/3" />
			</div>
		);
	}
	if (channels.length === 0) {
		return (
			<DashboardEmptyLine
				title="No bots configured"
				message="Private bots you create and public bots published by Clawdi will appear here."
			/>
		);
	}
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Bot</TableHead>
					<TableHead>Type</TableHead>
					<TableHead>Status</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{channels.map((channel) => (
					<TableRow
						key={channel.id}
						data-state={channel.id === selectedChannelId ? "selected" : undefined}
						className="cursor-pointer"
						onClick={() => onSelect(channel)}
					>
						<TableCell className="min-w-44 whitespace-normal">
							<div className="space-y-1">
								<div className="font-medium">{channel.name}</div>
								<div className="break-all font-mono text-xs text-muted-foreground">
									{shortId(channel.id)}
								</div>
							</div>
						</TableCell>
						<TableCell>
							<div className="flex flex-wrap gap-1.5">
								<ProviderBadge provider={channel.provider} />
								<VisibilityBadge visibility={channel.visibility} />
							</div>
						</TableCell>
						<TableCell>
							<Badge variant={channel.status === "active" ? "secondary" : "outline"}>
								{channel.status}
							</Badge>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function ChannelDetail({
	channel,
	links,
	bindings,
	agentMap,
	isLoadingLinks,
	isLoadingBindings,
	pairCode,
	latestAgentToken,
	isCreatingPairCode,
	onCreatePairCode,
}: {
	channel: ChannelAccount;
	links: ChannelAgentLink[];
	bindings: ChannelBinding[];
	agentMap: Map<string, Environment>;
	isLoadingLinks: boolean;
	isLoadingBindings: boolean;
	pairCode: ChannelPairCode | null;
	latestAgentToken: ChannelAgentLink | null;
	isCreatingPairCode: boolean;
	onCreatePairCode: (linkId: string) => void;
}) {
	return (
		<div className="space-y-5 p-4">
			<div className="grid gap-3 lg:grid-cols-2">
				<ReadOnlyField label="Webhook URL" value={channel.webhook_url} />
				<ReadOnlyField label="Channel ID" value={channel.id} />
			</div>

			{latestAgentToken?.agent_token ? (
				<SecretPanel
					title="Agent SDK token"
					description="Store this token in the agent runtime that will talk to the channel API."
					values={[{ label: "Agent token", value: latestAgentToken.agent_token }]}
				/>
			) : null}

			{pairCode ? (
				<SecretPanel
					title="Pair code"
					description="Send the command below in the external chat served by this bot."
					values={[
						{ label: "Pair command", value: `/bot_pair ${pairCode.code}` },
						{ label: "Expires at", value: formatAbsoluteTooltip(pairCode.expires_at) },
					]}
				/>
			) : null}

			<section className="space-y-3">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h3 className="text-sm font-semibold">Agent links</h3>
						<p className="text-xs text-muted-foreground">
							Each link gives one agent a bot-shaped credential for this channel.
						</p>
					</div>
				</div>
				{isLoadingLinks ? (
					<Skeleton className="h-28 w-full" />
				) : links.length === 0 ? (
					<DashboardEmptyLine
						title="No linked agents"
						message="Link an agent before generating a pair code."
					/>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Agent</TableHead>
								<TableHead>Link</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="text-right">Action</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{links.map((link) => {
								const agent = agentMap.get(link.agent_id);
								return (
									<TableRow key={link.id}>
										<TableCell className="min-w-56 whitespace-normal">
											{agent ? (
												<AgentLabel
													machineName={agent.machine_name}
													type={agent.agent_type}
													size="sm"
												/>
											) : (
												<div className="font-mono text-xs">{shortId(link.agent_id)}</div>
											)}
										</TableCell>
										<TableCell className="font-mono text-xs">{shortId(link.id)}</TableCell>
										<TableCell>
											<Badge variant={link.status === "active" ? "secondary" : "outline"}>
												{link.status}
											</Badge>
										</TableCell>
										<TableCell className="text-right">
											<Button
												variant="outline"
												size="sm"
												disabled={isCreatingPairCode}
												onClick={() => onCreatePairCode(link.id)}
											>
												<KeyRound />
												Pair
											</Button>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				)}
			</section>

			<section className="space-y-3">
				<div>
					<h3 className="text-sm font-semibold">Paired chats</h3>
					<p className="text-xs text-muted-foreground">
						A chat session routes to one active agent link at a time.
					</p>
				</div>
				{isLoadingBindings ? (
					<Skeleton className="h-28 w-full" />
				) : bindings.length === 0 ? (
					<DashboardEmptyLine
						title="No paired chats"
						message="Generate a pair code, then run it inside Telegram, Discord, WhatsApp, or iMessage."
					/>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Chat</TableHead>
								<TableHead>Type</TableHead>
								<TableHead>Agent link</TableHead>
								<TableHead>Paired</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{bindings.map((binding) => (
								<TableRow key={binding.id}>
									<TableCell className="min-w-56 whitespace-normal">
										<div className="space-y-1">
											<div className="font-medium">
												{binding.external_chat_name ?? binding.external_chat_id}
											</div>
											<div className="break-all font-mono text-xs text-muted-foreground">
												{binding.external_chat_id}
											</div>
										</div>
									</TableCell>
									<TableCell>{binding.external_chat_type ?? "chat"}</TableCell>
									<TableCell className="font-mono text-xs">
										{binding.agent_link_id ? shortId(binding.agent_link_id) : "—"}
									</TableCell>
									<TableCell>{relativeTime(binding.created_at)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</section>
		</div>
	);
}

function CreateChannelDialog({
	open,
	onOpenChange,
	agents,
	isLoadingAgents,
	createdChannel,
	isSubmitting,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agents: Environment[];
	isLoadingAgents: boolean;
	createdChannel: ChannelAccountCreated | null;
	isSubmitting: boolean;
	onSubmit: (body: ChannelAccountCreate) => void;
}) {
	const [provider, setProvider] = useState<ChannelProvider>("telegram");
	const [name, setName] = useState("");
	const [agentId, setAgentId] = useState(NO_AGENT);
	const [providerToken, setProviderToken] = useState("");
	const [configJson, setConfigJson] = useState("");
	const [secretsText, setSecretsText] = useState("");

	function resetForm() {
		setProvider("telegram");
		setName("");
		setAgentId(NO_AGENT);
		setProviderToken("");
		setConfigJson("");
		setSecretsText("");
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				onOpenChange(nextOpen);
				if (!nextOpen) resetForm();
			}}
		>
			<DialogTrigger asChild>
				<Button>
					<Plus />
					Create Channel
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Create private bot</DialogTitle>
					<DialogDescription>
						Private bots can only be linked to your agents. Public bots are managed by admins.
					</DialogDescription>
				</DialogHeader>

				{createdChannel ? (
					<SecretPanel
						title="Channel created"
						description="Store the one-time values below before closing this dialog."
						values={[
							{ label: "Channel ID", value: createdChannel.id },
							{ label: "Webhook URL", value: createdChannel.webhook_url },
							{ label: "Webhook secret", value: createdChannel.webhook_secret },
							...(createdChannel.agent_token
								? [{ label: "Agent SDK token", value: createdChannel.agent_token }]
								: []),
						]}
					/>
				) : (
					<div className="grid gap-4">
						<div className="grid gap-2">
							<Label htmlFor="channel-provider">Provider</Label>
							<Select value={provider} onValueChange={(value) => setProvider(parseProvider(value))}>
								<SelectTrigger id="channel-provider" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PROVIDERS.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="channel-name">Name</Label>
							<Input
								id="channel-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="support-bot"
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="channel-agent">Initial agent</Label>
							<AgentSelect
								id="channel-agent"
								agents={agents}
								value={agentId}
								onValueChange={setAgentId}
								disabled={isLoadingAgents}
								placeholder="Link later"
								includeNone
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="channel-provider-token">Provider token</Label>
							<Input
								id="channel-provider-token"
								type="password"
								value={providerToken}
								onChange={(event) => setProviderToken(event.target.value)}
								placeholder="Optional provider credential"
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="channel-config">Config JSON</Label>
							<Textarea
								id="channel-config"
								value={configJson}
								onChange={(event) => setConfigJson(event.target.value)}
								placeholder='{"bot_username":"my_bot"}'
								className="min-h-20 font-mono text-xs"
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="channel-secrets">Extra secrets</Label>
							<Textarea
								id="channel-secrets"
								value={secretsText}
								onChange={(event) => setSecretsText(event.target.value)}
								placeholder="APP_SECRET=value"
								className="min-h-20 font-mono text-xs"
							/>
						</div>
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
					{createdChannel ? null : (
						<Button
							disabled={isSubmitting || name.trim().length === 0}
							onClick={() => {
								const body = buildCreateChannelBody({
									provider,
									name,
									agentId,
									providerToken,
									configJson,
									secretsText,
								});
								if (body) onSubmit(body);
							}}
						>
							{isSubmitting ? <RefreshCw className="animate-spin" /> : <Plus />}
							Create
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function LinkAgentDialog({
	open,
	onOpenChange,
	agents,
	linkedAgentIds,
	isLoadingAgents,
	isSubmitting,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agents: Environment[];
	linkedAgentIds: Set<string>;
	isLoadingAgents: boolean;
	isSubmitting: boolean;
	onSubmit: (agentId: string) => void;
}) {
	const availableAgents = agents.filter((agent) => !linkedAgentIds.has(agent.id));
	const [agentId, setAgentId] = useState("");

	useEffect(() => {
		if (!open) {
			setAgentId("");
			return;
		}
		if (!agentId || !availableAgents.some((agent) => agent.id === agentId)) {
			setAgentId(availableAgents[0]?.id ?? "");
		}
	}, [agentId, availableAgents, open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					<LinkIcon />
					Link Agent
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Link agent</DialogTitle>
					<DialogDescription>
						The linked agent receives a channel-native credential for this bot.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-2">
					<Label htmlFor="link-agent">Agent</Label>
					<AgentSelect
						id="link-agent"
						agents={availableAgents}
						value={agentId}
						onValueChange={setAgentId}
						disabled={isLoadingAgents || availableAgents.length === 0}
						placeholder={availableAgents.length === 0 ? "No unlinked agents" : "Select agent"}
					/>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						disabled={isSubmitting || !agentId}
						onClick={() => {
							if (agentId) onSubmit(agentId);
						}}
					>
						{isSubmitting ? <RefreshCw className="animate-spin" /> : <LinkIcon />}
						Link
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function AgentSelect({
	id,
	agents,
	value,
	onValueChange,
	disabled,
	placeholder,
	includeNone = false,
}: {
	id: string;
	agents: Environment[];
	value: string;
	onValueChange: (value: string) => void;
	disabled?: boolean;
	placeholder: string;
	includeNone?: boolean;
}) {
	return (
		<Select value={value} onValueChange={onValueChange} disabled={disabled}>
			<SelectTrigger id={id} className="w-full">
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent>
				{includeNone ? <SelectItem value={NO_AGENT}>Link later</SelectItem> : null}
				{agents.map((agent) => (
					<SelectItem key={agent.id} value={agent.id}>
						{agentLabel(new Map([[agent.id, agent]]), agent.id)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function SecretPanel({
	title,
	description,
	values,
}: {
	title: string;
	description: string;
	values: { label: string; value: string }[];
}) {
	return (
		<div className="rounded-lg border bg-muted/20 p-3">
			<div className="mb-3 flex items-start gap-2">
				<Check className="mt-0.5 size-4 text-emerald-600" />
				<div className="min-w-0">
					<div className="text-sm font-medium">{title}</div>
					<p className="text-xs text-muted-foreground">{description}</p>
				</div>
			</div>
			<div className="space-y-2">
				{values.map((item) => (
					<ReadOnlyField key={item.label} label={item.label} value={item.value} />
				))}
			</div>
		</div>
	);
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0 rounded-md border bg-background px-3 py-2">
			<div className="mb-1 flex items-center justify-between gap-2">
				<span className="text-xs font-medium text-muted-foreground">{label}</span>
				<CopyButton value={value} />
			</div>
			<div className="break-all font-mono text-xs">{value}</div>
		</div>
	);
}

function CopyButton({ value }: { value: string }) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			className="h-7 px-2"
			onClick={() => {
				void navigator.clipboard.writeText(value);
				toast.success("Copied");
			}}
		>
			<Copy />
			Copy
		</Button>
	);
}

function ProviderBadge({ provider }: { provider: string }) {
	return <Badge variant="outline">{providerLabel(provider)}</Badge>;
}

function VisibilityBadge({ visibility }: { visibility: ChannelAccount["visibility"] }) {
	return (
		<Badge
			variant={visibility === "public" ? "default" : "secondary"}
			className={cn(visibility === "public" && "bg-emerald-600 text-white hover:bg-emerald-600")}
		>
			{visibility}
		</Badge>
	);
}

function buildCreateChannelBody({
	provider,
	name,
	agentId,
	providerToken,
	configJson,
	secretsText,
}: {
	provider: ChannelProvider;
	name: string;
	agentId: string;
	providerToken: string;
	configJson: string;
	secretsText: string;
}): ChannelAccountCreate | null {
	const config = parseConfigJson(configJson);
	if (config === undefined) return null;
	const secrets = parseSecrets(secretsText);
	if (secrets === undefined) return null;
	return {
		provider,
		name: name.trim(),
		agent_id: agentId === NO_AGENT ? null : agentId,
		provider_token: providerToken.trim() || null,
		config,
		secrets,
	};
}

function parseConfigJson(raw: string): Record<string, unknown> | null | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!isPlainObject(parsed)) {
			toast.error("Config JSON must be an object.");
			return undefined;
		}
		return parsed;
	} catch {
		toast.error("Config JSON is invalid.");
		return undefined;
	}
}

function parseSecrets(raw: string): Record<string, string> | null | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const secrets: Record<string, string> = {};
	for (const line of trimmed.split(/\r?\n/)) {
		const clean = line.trim();
		if (!clean) continue;
		const index = clean.indexOf("=");
		if (index <= 0) {
			toast.error("Secrets must use NAME=value lines.");
			return undefined;
		}
		const name = clean.slice(0, index).trim();
		const value = clean.slice(index + 1);
		if (!name || !value) {
			toast.error("Secrets must include non-empty names and values.");
			return undefined;
		}
		secrets[name] = value;
	}
	return Object.keys(secrets).length > 0 ? secrets : null;
}

function parseProvider(value: string): ChannelProvider {
	const provider = PROVIDERS.find((item) => item.value === value);
	if (!provider) return "telegram";
	return provider.value;
}

function providerLabel(provider: string): string {
	return PROVIDERS.find((item) => item.value === provider)?.label ?? provider;
}

function agentsById(agents: Environment[]): Map<string, Environment> {
	return new Map(agents.map((agent) => [agent.id, agent]));
}

function agentLabel(agentMap: Map<string, Environment>, agentId: string): string {
	const agent = agentMap.get(agentId);
	if (!agent) return shortId(agentId);
	const machine = cleanMachineName(agent.machine_name);
	const type = agentTypeLabel(agent.agent_type);
	return machine ? `${machine} · ${type}` : type;
}

function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 8) : id;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
