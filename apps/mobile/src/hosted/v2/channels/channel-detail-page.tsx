import {
	agentProviderLinkReplacementRequired,
	agentProviderLinkStatusUnknown,
	type ChannelPairing,
	type components,
	pairCodeExpired,
	telegramPairDeepLink,
	verifiedWhatsAppPairLink,
} from "@clawdi/shared/api";
import { agentOwnershipKindFromId } from "@clawdi/shared/client";
import {
	channelFormClasses,
	ENTITY_CARD_BASE,
	channelDetailPageClasses as styles,
	tabsContentClassName,
} from "@clawdi/shared/ui";
import {
	agentDisplayName,
	agentSectionHref,
	agentSurfaceCopy,
	channelFormCopy,
	channelRemovalCopy,
	channelRemovalTitle,
	channelDetailCopy as copy,
	pairedChatKindLabel,
	pairedChatScopeLabel,
	pairedChatsCopy,
	pairedChatsDescription,
	pairedChatsLoadFailed,
	pairedChatTitle,
	pairingCommandsDescription,
	providerLinkReplacementCopy,
	providerMeta,
	publishedCommandsLabel,
	relativeTime,
	supportsPairingCommands,
	unpairChatTitle,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import ArrowUpRight from "lucide-react-native/icons/arrow-up-right";
import KeyRound from "lucide-react-native/icons/key-round";
import Link2Off from "lucide-react-native/icons/link-2-off";
import MessageCircle from "lucide-react-native/icons/message-circle";
import MessagesSquare from "lucide-react-native/icons/messages-square";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import Unplug from "lucide-react-native/icons/unplug";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { ActionButton, ChoiceSelect as NativePicker } from "@/components/dashboard/controls";
import { EmptyState } from "@/components/empty-state";
import { EntityHeader } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import { Alert } from "@/components/ui/alert";
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/input";
import { NativeList } from "@/components/ui/native-list";
import { SheetPage } from "@/components/ui/sheet-page";
import { Skeleton } from "@/components/ui/skeleton";
import { Text as AppText } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { AppView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useCloudAgents } from "@/hooks/cloud-inventory";
import { useAgentOwnership } from "@/hooks/use-agent-ownership";
import { DiscordConnectionIssueAlert } from "@/hosted/v2/channels/channel-card";
import { ChannelHealthTab } from "@/hosted/v2/channels/channel-health-tab";
import { ChannelInfoCard } from "@/hosted/v2/channels/channel-info-card";
import { useChannelQuery } from "@/hosted/v2/channels/channels-hooks";
import { ChannelPairingView } from "@/hosted/v2/channels/pairing-dialog-ui";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeHeader } from "@/platform/navigation/native-header";
import { NativeSegments } from "@/platform/navigation/segmented-control";
import { useSheet } from "@/platform/navigation/use-sheet";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function ChannelDetailScreen({ mode }: { mode?: "link" | "pair" | "chats" } = {}) {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{
		id?: string | string[];
		agentId?: string | string[];
		linkId?: string;
		action?: string;
	}>();
	const id = routeParam(params.id);
	return (
		<ChannelDetail
			key={`${scope.accountKey}:${scope.generation}:${id}`}
			id={id}
			initialAgentId={routeParam(params.agentId)}
			linkId={params.linkId}
			mode={mode}
			initialAction={params.action}
		/>
	);
}

function ChannelDetail({
	id,
	initialAgentId,
	linkId,
	mode,
	initialAction,
}: {
	id?: string;
	initialAgentId?: string;
	linkId?: string;
	mode?: "link" | "pair" | "chats";
	initialAction?: string;
}) {
	const t = useI18n();
	const confirmationDialog = useConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { channels } = useMobileApi();
	const cache = useQueryClient();
	const router = useRouter();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const sheet = useSheet<boolean>({
		fallback: id ? `/channels/${encodeURIComponent(id)}` : "/channels",
		busy: action.busy,
	});
	const [agentId, setAgentId] = useState(initialAgentId ?? "");
	const [tab, setTab] = useState("activity");
	const [commands, setCommands] = useState<
		components["schemas"]["ChannelCommandSyncResponse"] | null
	>(null);
	const [pairing, setPairing] = useState<ChannelPairing | null>(null);
	// Web reports results with toasts; mobile keeps the failed action's title and any unpair warning.
	const [failureTitle, setFailureTitle] = useState<string>();
	const [unpairWarning, setUnpairWarning] = useState<string | null>(null);
	const pool = useChannelQuery(["pool"], (api, signal) => api.pool(signal));
	const owned = useChannelQuery(["owned"], (api, signal) => api.list(signal));
	const ownedBot = owned.isError ? undefined : owned.data?.find((item) => item.id === id);
	const bot = Object.values(pool.data?.providers ?? {})
		.flat()
		.find((item) => item.id === id);
	const provider = bot?.provider ?? ownedBot?.provider ?? "";
	const links = useChannelQuery(
		[id ?? "missing", "links"],
		(api, signal) => api.links(id ?? "", signal),
		Boolean(id),
	);
	const bindings = useChannelQuery(
		[id ?? "missing", "bindings"],
		(api, signal) => api.bindings(id ?? "", signal),
		Boolean(id && mode === "chats"),
	);
	const activity = useChannelQuery(
		[id ?? "missing", "activity"],
		(api, signal) => api.activity(id ?? "", signal),
		Boolean(id),
	);
	const agents = useCloudAgents();
	const ownership = useAgentOwnership();
	const selectableAgents = (agents.data ?? []).filter((agent) => {
		const kind = agentOwnershipKindFromId(agent.id, ownership.data ?? null);
		return kind === "cloud" || kind === "connected";
	});
	const health = useChannelQuery(["health"], (api, signal) => api.health(signal));
	const selected = selectableAgents.find((agent) => agent.id === agentId);
	const agentLinks = useChannelQuery(
		["agent", agentId],
		(api, signal) => api.agentLinks(agentId, signal),
		Boolean(selected),
	);
	const providers = agentLinks.data
		? new Set(
				agentLinks.data
					.filter((link) => link.status === "active")
					.map((link) => link.account.provider),
			)
		: undefined;
	const replacement = agentProviderLinkReplacementRequired(
		selected?.agent_type,
		bot?.provider ?? "",
		providers,
	);
	const unknown =
		agentLinks.isError ||
		agentLinks.isPending ||
		agentProviderLinkStatusUnknown(selected?.agent_type, bot?.provider ?? "", providers);
	const ready = Boolean(
		id && (ownedBot || (bot && !pool.isError)) && scope.isReady && scope.isCurrent(),
	);
	const disabled = !ready || action.busy;
	const linkDisabled =
		disabled || ownership.isFetching || ownership.isError || !selected || unknown;
	const clearPairing = useCallback(() => setPairing(null), []);
	useFocusEffect(useCallback(() => clearPairing, [clearPairing]));
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") clearPairing();
		});
		return () => listener.remove();
	}, [clearPairing]);
	useEffect(() => {
		if (!pairing) return;
		const delay = Date.parse(pairing.expires_at) - Date.now();
		if (!Number.isFinite(delay) || delay <= 0) {
			clearPairing();
			return;
		}
		const timer = setTimeout(clearPairing, Math.min(delay, 300_000));
		return () => clearTimeout(timer);
	}, [pairing, clearPairing]);
	const refresh = async () => {
		await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "channels") });
	};
	const perform = (
		title: string,
		operation: (signal: AbortSignal) => Promise<unknown>,
		after?: () => void | Promise<void>,
	) =>
		action.runOrThrow(async (current) => {
			const visible = capture();
			if (!ready || !visible()) return;
			setFailureTitle(title);
			setUnpairWarning(null);
			await read(operation);
			if (!current() || !visible()) return;
			setPairing(null);
			await refresh();
			if (current() && visible()) await after?.();
		});
	const confirm = (
		title: string,
		warning: string,
		operation: () => unknown,
		confirmLabel = title,
	) => {
		const visible = capture();
		confirmationDialog.show(title, warning, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: confirmLabel,
				style: "destructive",
				onPress: () => {
					if (scope.isCurrent() && !scope.signal.aborted && visible()) return operation();
				},
			},
		]);
	};
	const removeChannel = () =>
		confirm(
			channelRemovalTitle(
				ownedBot?.name ?? bot?.name ?? "Channel",
				ownedBot?.provider === "whatsapp",
			),
			ownedBot?.provider === "whatsapp"
				? channelRemovalCopy.whatsappDescription
				: channelRemovalCopy.description,
			() =>
				perform(
					channelRemovalCopy.removeFailed,
					(signal) => channels.remove(id ?? "", signal),
					() => router.replace("/channels"),
				),
			ownedBot?.provider === "whatsapp" ? channelRemovalCopy.disconnect : channelRemovalCopy.remove,
		);
	const deleteRequested = useRef(false);
	useEffect(() => {
		if (
			initialAction !== "delete" ||
			deleteRequested.current ||
			!ready ||
			disabled ||
			!ownedBot ||
			mode
		)
			return;
		deleteRequested.current = true;
		router.setParams({ action: undefined });
		removeChannel();
	});
	const pairingLink =
		!pairing || !bot
			? null
			: bot.provider === "telegram"
				? telegramPairDeepLink({
						deepLink: pairing.deep_link,
						qrPayload: pairing.qr_payload,
						botUsername: pairing.bot_username,
						code: pairing.code,
					})
				: bot.provider === "whatsapp"
					? verifiedWhatsAppPairLink({
							deepLink: pairing.deep_link,
							qrPayload: pairing.qr_payload,
							pairingCommand: pairing.pairing_command,
							code: pairing.code,
						})
					: null;
	const open = (url: string) =>
		void action.run(async () => {
			if (!capture()() || !pairing || pairCodeExpired(pairing.expires_at, Date.now())) return;
			await Linking.openURL(url);
		});

	const pairLink = links.data?.find((link) => link.id === linkId && link.status === "active");
	const generate = () =>
		action.run(async (current) => {
			const visible = capture();
			if (!ready || !visible() || !linkId || !pairLink || !bot?.capabilities.pair_chat) return;
			setFailureTitle(copy.pairFailed);
			setPairing(null);
			const code = await read((signal) => channels.pair(id ?? "", linkId, signal));
			if (
				current() &&
				visible() &&
				code.agent_link_id === linkId &&
				!pairCodeExpired(code.expires_at, Date.now())
			)
				setPairing(code);
		});
	const generationStarted = useRef(false);
	const generateRef = useRef(generate);
	generateRef.current = generate;
	useEffect(() => {
		if (
			mode !== "pair" ||
			generationStarted.current ||
			!ready ||
			!pairLink ||
			!bot?.capabilities.pair_chat
		)
			return;
		generationStarted.current = true;
		void generateRef.current();
	}, [mode, ready, pairLink, bot?.capabilities.pair_chat]);
	if (mode === "link")
		return (
			<SheetPage
				title={channelFormCopy.linkTitle}
				description={channelFormCopy.linkDescription}
				fallback={id ? `/channels/${encodeURIComponent(id)}` : "/channels"}
				busy={action.busy}
				sheet={sheet}
			>
				{bot?.capabilities.link_agent && bot.available ? (
					<>
						<WebView recipe={channelFormClasses.field}>
							<Label>{channelFormCopy.agent}</Label>
							<NativePicker
								value={agentId}
								options={[
									{ value: "", label: channelFormCopy.chooseAgent },
									...selectableAgents.map((agent) => ({
										value: agent.id,
										label: agent.name,
									})),
								]}
								disabled={disabled || agents.isError || ownership.isFetching || ownership.isError}
								onValueChange={setAgentId}
							/>
						</WebView>
						<WebView recipe={channelFormClasses.field}>
							<ActionButton
								label={t("account.cancel")}
								disabled={action.busy}
								onPress={() =>
									void action.run(async () => {
										await sheet.close();
									})
								}
							/>
							<ActionButton
								label={action.busy ? copy.linking : channelFormCopy.linkTitle}
								disabled={linkDisabled}
								onPress={() => {
									if (linkDisabled) return;
									const link = () =>
										perform(
											copy.linkFailed,
											(signal) => channels.link(id ?? "", agentId, replacement, signal),
											() => sheet.close(true),
										).catch(() => undefined);
									if (!replacement) return void link();
									// Web's ProviderLinkReplacementConfirm.
									const replace = providerLinkReplacementCopy(providerMeta(bot.provider).label);
									confirm(
										replace.title,
										`${replace.limit} ${replace.linkingBefore}${bot.name}${replace.linkingAfter}`,
										link,
										replace.confirm,
									);
								}}
							/>
						</WebView>
						{ownership.isError ? (
							<ApiErrorPanel error={ownership.error} onRetry={() => void ownership.refetch()} />
						) : null}
						{action.error ? <ApiErrorPanel error={action.failure} title={failureTitle} /> : null}
					</>
				) : pool.isPending || owned.isPending ? (
					<Skeleton className={webView(styles.activitySkeleton)} />
				) : (
					<ApiErrorPanel
						error={pool.error ?? owned.error}
						title={agentSurfaceCopy.couldnTLoadChannels}
						onRetry={() => void pool.refetch()}
					/>
				)}
				{confirmationDialog.dialog}
			</SheetPage>
		);
	if (mode === "pair") {
		return (
			<SheetPage
				title={t("labels.pairChannel", { provider: providerMeta(provider).label })}
				fallback={id ? `/channels/${encodeURIComponent(id)}` : "/channels"}
				busy={action.busy}
				sheet={sheet}
			>
				<WebView recipe={channelFormClasses.field}>
					{action.busy ? <Skeleton className={webView(styles.activitySkeleton)} /> : null}
					{pairing ? (
						<ChannelPairingView
							provider={provider}
							identity={bot?.name ?? ownedBot?.name ?? "Channel"}
							pairing={pairing}
							link={pairingLink}
							busy={action.busy}
							open={open}
						/>
					) : null}
					<ActionButton
						label={copy.pairChat}
						disabled={disabled || !pairLink || !bot?.capabilities.pair_chat}
						onPress={() => void generate()}
					/>
					{action.error ? <ApiErrorPanel error={action.failure} title={failureTitle} /> : null}
				</WebView>
			</SheetPage>
		);
	}

	const linkCards =
		links.data
			?.filter((link) => link.status === "active")
			.map((link) => {
				const linkedAgent = agents.data?.find((agent) => agent.id === link.agent_id);
				return (
					<AppView key={link.id} className={webView(ENTITY_CARD_BASE)}>
						<EntityHeader
							align="start"
							icon={
								<AgentIcon
									agent={agents.data?.find((agent) => agent.id === link.agent_id)?.agent_type}
									size="sm"
								/>
							}
							title={linkedAgent ? agentDisplayName(linkedAgent) : t("agents.unavailable")}
							meta={[t("channels.linkedAt", { time: relativeTime(link.created_at) })]}
						/>
						{bot?.capabilities.pair_chat ? (
							<ActionButton
								label={copy.pairChat}
								disabled={disabled}
								onPress={() =>
									router.push({
										pathname: "/channels/[id]/pair",
										params: { id: id ?? "", linkId: link.id },
									})
								}
							/>
						) : null}
						<ActionButton
							label={copy.openAgentChannels}
							icon={<Icon as={ArrowUpRight} />}
							variant="ghost"
							onPress={() => router.push(agentSectionHref(link.agent_id, "channels"))}
						/>
						<ActionButton
							label={copy.unlink}
							icon={<Icon as={Unplug} />}
							variant="ghost"
							disabled={disabled}
							onPress={() =>
								confirm(
									copy.unlinkTitle,
									copy.unlinkDescription,
									() =>
										perform(copy.unlinkFailed, (signal) =>
											channels.unlink(id ?? "", link.id, signal),
										),
									copy.unlink,
								)
							}
						/>
					</AppView>
				);
			}) ?? [];
	const pairedChats =
		bindings.data?.filter(
			(binding) => binding.agent_link_id === linkId && binding.status.toLowerCase() === "active",
		) ?? [];
	const bindingCards = pairedChats.map((binding) => {
		const chatName = pairedChatTitle(binding, provider);
		const privateChat =
			binding.external_chat_type?.toLowerCase() === "private" ||
			pairedChatScopeLabel(provider, binding) === "direct message";
		return (
			<AppView key={binding.id} className={webView(ENTITY_CARD_BASE)}>
				<EntityHeader
					align="start"
					icon={
						<IconChip size="sm">
							<Icon as={privateChat ? MessageCircle : MessagesSquare} />
						</IconChip>
					}
					title={binding.external_chat_name?.trim() || binding.external_chat_id}
					meta={[
						pairedChatKindLabel(provider, binding),
						binding.last_message_at
							? `Last activity ${relativeTime(binding.last_message_at)}`
							: null,
					]}
				/>
				<ActionButton
					label={pairedChatsCopy.unpair}
					icon={<Icon as={Link2Off} />}
					variant="ghost"
					disabled={disabled}
					onPress={() =>
						confirm(
							unpairChatTitle(chatName),
							pairedChatsCopy.unpairDescription,
							() =>
								action.runOrThrow(async (current) => {
									const visible = capture();
									if (!ready || !visible()) return;
									setFailureTitle(pairedChatsCopy.unpairFailed);
									setUnpairWarning(null);
									const result = await read((signal) =>
										channels.unpair(id ?? "", binding.id, signal),
									);
									if (!current() || !visible()) return;
									if (!result.unpaired) throw new Error("Chat not unpaired");
									setUnpairWarning(result.warning ?? null);
									await refresh();
								}),
							pairedChatsCopy.unpairConfirm,
						)
					}
				/>
			</AppView>
		);
	});
	if (mode === "chats")
		return (
			<SheetPage
				title={pairedChatsCopy.title}
				fallback={id ? `/channels/${encodeURIComponent(id)}` : "/channels"}
				busy={action.busy}
				sheet={sheet}
				scroll={false}
			>
				<NativeList
					data={bindingCards}
					keyExtractor={(row, index) => String(row.key ?? index)}
					renderItem={({ item }) => item}
					refreshing={bindings.isRefetching}
					onRefresh={() => void bindings.refetch()}
					header={
						<>
							<AppText className="font-medium">{bot?.name ?? ownedBot?.name}</AppText>
							<AppText className="text-muted-foreground">
								{pairedChatsDescription(pairedChats.length)}
							</AppText>
							{unpairWarning ? (
								<Alert title={pairedChatsCopy.unpaired}>{unpairWarning}</Alert>
							) : null}
							{action.error ? <ApiErrorPanel error={action.failure} title={failureTitle} /> : null}
						</>
					}
					empty={
						bindings.isPending ? (
							<Skeleton className={webView(styles.activitySkeleton)} />
						) : bindings.isError ? (
							<ApiErrorPanel
								error={bindings.error}
								title={pairedChatsLoadFailed(provider)}
								onRetry={() => void bindings.refetch()}
							/>
						) : (
							<EmptyState variant="inset" description={pairedChatsCopy.empty} />
						)
					}
				/>
				{confirmationDialog.dialog}
			</SheetPage>
		);
	const eventCards =
		tab === "activity"
			? (activity.data?.items.map((event) => (
					<AppView key={event.id} className={webView(ENTITY_CARD_BASE)}>
						<AppText>
							{event.created_at} · {event.direction ?? event.kind} ·{" "}
							{event.delivery_status ?? event.outcome}
						</AppText>
						<AppText selectable>{event.text?.slice(0, 12000)}</AppText>
					</AppView>
				)) ?? [])
			: [];
	const listRows = [
		...linkCards,
		...(ownedBot?.provider === "whatsapp"
			? [
					<ActionButton
						key="repair"
						label={t("whatsapp.repair")}
						disabled={disabled}
						onPress={() =>
							router.push({ pathname: "/channels/whatsapp", params: { accountId: ownedBot.id } })
						}
					/>,
				]
			: []),
		<AppView key="tab-selector">
			<NativeSegments
				value={tab}
				onChange={setTab}
				options={[
					{ value: "activity", label: agentSurfaceCopy.activity },
					{ value: "health", label: agentSurfaceCopy.health },
					{ value: "commands", label: agentSurfaceCopy.commands },
				]}
			/>
		</AppView>,
		...eventCards,
	];

	return (
		<SafeAreaScreen>
			<NativeHeader
				title={bot?.name ?? ownedBot?.name ?? t("channels.title")}
				menu={{
					label: t("sessionDetail.more"),
					items: [
						...(ownedBot ||
						(bot?.access === "owner" && bot.capabilities.manage_account && !pool.isError)
							? [
									{
										id: "remove",
										label:
											ownedBot?.provider === "whatsapp" ? agentSurfaceCopy.disconnect : "Delete",
										disabled,
										destructive: true,
										onPress: removeChannel,
									},
								]
							: []),
					],
				}}
			/>
			<NativeList
				data={listRows}
				keyExtractor={(row, index) => String(row.key ?? index)}
				renderItem={({ item }) => item}
				refreshing={links.isRefetching || activity.isRefetching || health.isRefetching}
				onRefresh={() => {
					void links.refetch();
					void activity.refetch();
					void health.refetch();
				}}
				header={
					<AppView className={webView(styles.skeletonContent)}>
						<PageHeader
							title={bot?.name ?? ownedBot?.name ?? t("channels.title")}
							description={providerMeta(provider).label}
							icon={
								<EntityIcon kind="channel" id={provider} label={t("channels.singular")} size="lg" />
							}
						/>
						{provider === "discord" ? (
							<DiscordConnectionIssueAlert
								issue={ownedBot?.connection_issue ?? bot?.connection_issue}
							/>
						) : null}
						{action.error ? (
							<ApiErrorPanel error={action.failure} title={failureTitle} />
						) : links.isError ? (
							<ApiErrorPanel
								error={links.error}
								title={copy.loadLinkedAgentsFailed}
								onRetry={() => void links.refetch()}
							/>
						) : activity.isError || pool.isError || agents.isError ? (
							<ApiErrorPanel
								error={activity.error ?? pool.error ?? agents.error}
								onRetry={() => {
									void activity.refetch();
									void pool.refetch();
									void agents.refetch();
								}}
							/>
						) : null}
						{(bot?.provider ?? ownedBot?.provider) === "discord" ? (
							<WebView recipe={styles.notice}>
								<WebView recipe={styles.noticeHeader} className="flex-row">
									<IconChip size="sm" tint={styles.infoTint}>
										<Icon as={TriangleAlert} />
									</IconChip>
									<WebView recipe={styles.noticeBody}>
										<WebText recipe={styles.noticeTitle}>{copy.discordTitle}</WebText>
										<WebText recipe={styles.noticeDescription}>{copy.discordDescription}</WebText>
									</WebView>
								</WebView>
							</WebView>
						) : null}
						<SectionLabel count={links.data?.filter((link) => link.status === "active").length}>
							{agentSurfaceCopy.linkedAgents}
						</SectionLabel>
						{links.data?.filter((link) => link.status === "active").length === 0 ? (
							<EmptyState
								variant="inset"
								title={copy.noLinkedAgents}
								description={copy.noLinkedAgentsDescription}
							/>
						) : null}
						{bot?.capabilities.link_agent && bot.available ? (
							<ActionButton
								label={channelFormCopy.linkTitle}
								disabled={disabled}
								onPress={() =>
									router.push({ pathname: "/channels/[id]/link", params: { id: id ?? "" } })
								}
							/>
						) : null}
					</AppView>
				}
				footer={
					<AppView>
						{tab === "activity" ? (
							<WebView recipe={tabsContentClassName}>
								{!activity.isPending && !activity.isError && !activity.data?.items.length ? (
									<EmptyState title={copy.noActivity} description={copy.noActivityDescription} />
								) : null}
							</WebView>
						) : null}
						{tab === "health" ? (
							<WebView recipe={tabsContentClassName}>
								{health.isPending ? (
									<Skeleton className={webView(styles.activitySkeleton)} />
								) : health.isError ? (
									<ApiErrorPanel
										error={health.error}
										title={agentSurfaceCopy.couldnTLoadChannelHealth}
										onRetry={() => void health.refetch()}
									/>
								) : (
									<ChannelHealthTab
										health={health.data?.items.find((item) => item.account_id === id)}
									/>
								)}
							</WebView>
						) : null}
						{tab === "commands" ? (
							<WebView recipe={tabsContentClassName}>
								<WebView recipe={styles.skeletonContent}>
									<ChannelInfoCard icon={KeyRound} title={copy.pairingCommands}>
										{pairingCommandsDescription(
											providerMeta(provider).label,
											supportsPairingCommands(provider),
										)}
									</ChannelInfoCard>
									{supportsPairingCommands(provider) ? (
										<ActionButton
											label={action.busy ? copy.publishing : copy.publishCommands}
											variant="default"
											icon={<Icon as={RefreshCw} />}
											disabled={disabled || !bot?.capabilities.sync_commands}
											onPress={() => {
												let published: components["schemas"]["ChannelCommandSyncResponse"] | null =
													null;
												void perform(
													copy.syncFailed,
													async (signal) => {
														published = await channels.syncCommands(id ?? "", signal);
														return published;
													},
													() => setCommands(published),
												).catch(() => undefined);
											}}
										/>
									) : null}
									{commands?.commands.length ? (
										<WebView recipe={`${ENTITY_CARD_BASE} ${styles.activityList}`}>
											<WebText recipe={styles.commandsHeading}>
												{publishedCommandsLabel(commands.commands.length)}
											</WebText>
											{commands.commands.map((command) => (
												<WebView
													key={String(command.name)}
													recipe={styles.command}
													className="flex-row"
												>
													<WebText recipe={styles.commandName}>/{String(command.name)}</WebText>
													<WebText recipe={styles.commandDescription}>
														{String(command.description)}
													</WebText>
												</WebView>
											))}
										</WebView>
									) : commands ? (
										<EmptyState variant="inset" description={copy.noCommands} />
									) : null}
								</WebView>
							</WebView>
						) : null}
					</AppView>
				}
			/>
			{confirmationDialog.dialog}
		</SafeAreaScreen>
	);
}
