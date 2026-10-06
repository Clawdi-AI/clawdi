import {
	agentProviderLinkReplacementRequired,
	agentProviderLinkStatusUnknown,
	type ChannelPairing,
	type components,
	pairCodeExpired,
	telegramPairDeepLink,
	verifiedDiscordInstallUrl,
	verifiedDiscordPairingCommand,
	verifiedWhatsAppPairLink,
} from "@clawdi/shared/api";
import { agentOwnershipKindFromId } from "@clawdi/shared/client";
import {
	agentsIndexClasses,
	channelFormClasses,
	ENTITY_CARD_BASE,
	channelDetailPageClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentDisplayName,
	agentSurfaceCopy,
	channelFormCopy,
	channelRemovalCopy,
	channelRemovalTitle,
	channelDetailCopy as copy,
	pairingCommandsDescription,
	providerMeta,
	publishedCommandsLabel,
	relativeTime,
	supportsPairingCommands,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { KeyRound, RefreshCw, Trash2, TriangleAlert, Unplug } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useMobileApi } from "@/components/api-provider";
import { AgentIcon } from "@/components/dashboard/agent-section-icon";
import {
	ActionButton as NativeButton,
	ChoiceSelect as NativePicker,
	NativeSwitch,
} from "@/components/dashboard/controls";
import { EmptyState } from "@/components/empty-state";
import { EntityHeader } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/input";
import { AppScrollView, AppText, AppView } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { BackButton, useCloudAgents } from "@/hooks/cloud-inventory";
import { useAgentOwnership } from "@/hooks/use-agent-ownership";
import { ChannelHealthTab } from "@/hosted/v2/channels/channel-health-tab";
import { ChannelInfoCard } from "@/hosted/v2/channels/channel-info-card";
import { useChannelQuery } from "@/hosted/v2/channels/channels-hooks";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { ReadScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function ChannelDetailScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ id?: string | string[]; agentId?: string | string[] }>();
	const id = routeParam(params.id);
	return (
		<ChannelDetail
			key={`${scope.accountKey}:${scope.generation}:${id}`}
			id={id}
			initialAgentId={routeParam(params.agentId)}
		/>
	);
}

function ChannelDetail({ id, initialAgentId }: { id?: string; initialAgentId?: string }) {
	const t = useI18n();
	const confirmationDialog = useConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { channels } = useMobileApi();
	const cache = useQueryClient();
	const router = useRouter();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const [agentId, setAgentId] = useState(initialAgentId ?? "");
	const [linkOpen, setLinkOpen] = useState(false);
	const [replace, setReplace] = useState(false);
	const [commands, setCommands] = useState<
		components["schemas"]["ChannelCommandSyncResponse"] | null
	>(null);
	const [pairing, setPairing] = useState<ChannelPairing | null>(null);
	const [notice, setNotice] = useState<"done" | "cleanupWarning" | "unpairNotConfirmed" | null>(
		null,
	);
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
		Boolean(id),
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
		disabled ||
		ownership.isFetching ||
		ownership.isError ||
		!selected ||
		unknown ||
		(replacement && !replace);
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
	const perform = (operation: (signal: AbortSignal) => Promise<unknown>, after?: () => void) =>
		action.run(async (current) => {
			const visible = capture();
			if (!ready || !visible()) return;
			setNotice(null);
			await read(operation);
			if (!current() || !visible()) return;
			setNotice("done");
			setPairing(null);
			await refresh();
			if (current() && visible()) after?.();
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
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName={webView(agentsIndexClasses.page)}>
				<BackButton />
				<PageHeader
					title={bot?.name ?? ownedBot?.name ?? "Channels"}
					description={providerMeta(bot?.provider ?? ownedBot?.provider ?? "").label}
					actions={
						ownedBot ||
						(bot?.access === "owner" && bot.capabilities.manage_account && !pool.isError) ? (
							<NativeButton
								label={ownedBot?.provider === "whatsapp" ? agentSurfaceCopy.disconnect : "Delete"}
								icon={<Icon as={ownedBot?.provider === "whatsapp" ? Unplug : Trash2} />}
								disabled={disabled}
								onPress={() =>
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
												(signal) => channels.remove(id ?? "", signal),
												() => router.replace("/channels"),
											),
										ownedBot?.provider === "whatsapp"
											? channelRemovalCopy.disconnect
											: channelRemovalCopy.remove,
									)
								}
							/>
						) : null
					}
					icon={
						<EntityIcon
							kind="channel"
							id={bot?.provider ?? ownedBot?.provider ?? ""}
							label="Channel"
							size="lg"
						/>
					}
				/>
				<NativeButton
					label={t("channels.refresh")}
					onPress={() =>
						action.run(async () => {
							await refresh();
							await agents.refetch();
						})
					}
					disabled={action.busy}
				/>
				{action.error ||
				links.isError ||
				bindings.isError ||
				activity.isError ||
				pool.isError ||
				agents.isError ||
				agentLinks.isError ? (
					<ApiErrorPanel
						error={
							action.error ??
							links.error ??
							bindings.error ??
							activity.error ??
							pool.error ??
							agents.error ??
							agentLinks.error
						}
						title={t("channels.failed")}
					/>
				) : null}
				{notice ? <AppText accessibilityRole="alert">{t(`channels.${notice}`)}</AppText> : null}
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
					<>
						<NativeButton
							label={channelFormCopy.linkTitle}
							disabled={disabled}
							onPress={() => setLinkOpen(true)}
						/>
						<Dialog
							open={linkOpen}
							onOpenChange={(next) => {
								if (!action.busy) setLinkOpen(next);
							}}
						>
							<DialogContent
								className={webView(channelFormClasses.content)}
								showCloseButton={!action.busy}
							>
								<DialogHeader>
									<DialogTitle>{channelFormCopy.linkTitle}</DialogTitle>
									<DialogDescription>{channelFormCopy.linkDescription}</DialogDescription>
								</DialogHeader>
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
										disabled={
											disabled || agents.isError || ownership.isFetching || ownership.isError
										}
										onValueChange={(value) => {
											setAgentId(value);
											setReplace(false);
										}}
									/>
								</WebView>
								{replacement ? (
									<>
										<AppText>{t("channels.replaceWarning")}</AppText>
										<NativeSwitch
											label={t("channels.replace")}
											value={replace}
											onValueChange={setReplace}
											disabled={disabled}
										/>
									</>
								) : null}
								<DialogFooter>
									<NativeButton
										label={t("account.cancel")}
										disabled={action.busy}
										onPress={() => setLinkOpen(false)}
									/>
									<NativeButton
										label={t("channels.link")}
										disabled={linkDisabled}
										onPress={() => {
											if (linkDisabled) return;
											perform(
												(signal) =>
													channels.link(id ?? "", agentId, replacement && replace, signal),
												() => {
													setReplace(false);
													setLinkOpen(false);
												},
											);
										}}
									/>
								</DialogFooter>
								{ownership.isError ? (
									<ApiErrorPanel error={ownership.error} onRetry={() => void ownership.refetch()} />
								) : null}
								{action.error ? <ApiErrorPanel error={t("channels.failed")} /> : null}
							</DialogContent>
						</Dialog>
					</>
				) : null}
				{links.data
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
									title={linkedAgent ? agentDisplayName(linkedAgent) : "Agent unavailable"}
									meta={[`Linked ${relativeTime(link.created_at)}`]}
								/>
								{bot?.capabilities.pair_chat ? (
									<NativeButton
										label={t("channels.pair")}
										disabled={disabled}
										onPress={() =>
											void action.run(async (current) => {
												const visible = capture();
												if (!ready || !visible()) return;
												setPairing(null);
												const code = await read((signal) =>
													channels.pair(id ?? "", link.id, signal),
												);
												if (
													current() &&
													visible() &&
													code.agent_link_id === link.id &&
													!pairCodeExpired(code.expires_at, Date.now())
												)
													setPairing(code);
											})
										}
									/>
								) : null}
								<NativeButton
									label={t("channels.unlink")}
									icon={<Icon as={Unplug} />}
									variant="ghost"
									disabled={disabled}
									onPress={() =>
										confirm(
											copy.unlinkTitle,
											copy.unlinkDescription,
											() => perform((signal) => channels.unlink(id ?? "", link.id, signal)),
											copy.unlink,
										)
									}
								/>
							</AppView>
						);
					})}
				{pairing ? (
					<Dialog
						open
						onOpenChange={(next) => {
							if (!next) clearPairing();
						}}
					>
						<DialogContent className={webView(channelFormClasses.pairingContent)}>
							<DialogHeader>
								<DialogTitle>{`Pair ${providerMeta(bot?.provider ?? "telegram").label}`}</DialogTitle>
							</DialogHeader>
							<AppText>{t("channels.pairInstructions")}</AppText>
							{verifiedDiscordPairingCommand(pairing.pairing_command, pairing.code) ? (
								<AppText selectable>{pairing.pairing_command}</AppText>
							) : null}
							<AppText>{pairing.expires_at}</AppText>
							{pairingLink ? (
								<NativeButton
									label={t("channels.openPair")}
									onPress={() => open(pairingLink)}
									disabled={action.busy}
								/>
							) : null}
							{bot?.provider === "discord"
								? [
										{
											value: verifiedDiscordInstallUrl(pairing.discord_install_url),
											label: t("channels.install"),
										},
										{
											value: verifiedDiscordInstallUrl(pairing.discord_user_install_url),
											label: t("channels.installUser"),
										},
									].map(({ value, label }) =>
										value ? (
											<NativeButton
												key={label}
												label={label}
												onPress={() => open(value)}
												disabled={action.busy}
											/>
										) : null,
									)
								: null}
							<NativeButton label={t("account.cancel")} onPress={clearPairing} />
						</DialogContent>
					</Dialog>
				) : null}
				<SectionLabel>Paired chats</SectionLabel>
				{bindings.data?.length === 0 ? <AppText>{t("channels.noBindings")}</AppText> : null}
				{bindings.data?.map((binding) => (
					<AppView key={binding.id} className={webView(ENTITY_CARD_BASE)}>
						<AppText selectable>
							{binding.external_chat_name ?? binding.external_chat_id} · {binding.status}
						</AppText>
						<NativeButton
							label={t("channels.unpair")}
							disabled={disabled}
							onPress={() =>
								confirm(
									t("channels.unpair"),
									t("channels.unpairWarning"),
									() =>
										void action.run(async (current) => {
											const visible = capture();
											if (!ready || !visible()) return;
											const result = await read((signal) =>
												channels.unpair(id ?? "", binding.id, signal),
											);
											if (!current() || !visible()) return;
											setNotice(
												!result.unpaired
													? "unpairNotConfirmed"
													: result.warning ||
															result.notification_status === "failed" ||
															result.provider_cleanup_status === "failed"
														? "cleanupWarning"
														: "done",
											);
											await refresh();
										}),
								)
							}
						/>
					</AppView>
				))}
				{ownedBot?.provider === "whatsapp" ? (
					<NativeButton
						label={t("whatsapp.repair")}
						disabled={disabled}
						onPress={() =>
							router.push({ pathname: "/channels/whatsapp", params: { accountId: ownedBot.id } })
						}
					/>
				) : null}
				<Tabs defaultValue="activity">
					<TabsList variant="default">
						<TabsTrigger value="activity">{agentSurfaceCopy.activity}</TabsTrigger>
						<TabsTrigger value="health">{agentSurfaceCopy.health}</TabsTrigger>
						<TabsTrigger value="commands">{agentSurfaceCopy.commands}</TabsTrigger>
					</TabsList>
					<TabsContent value="activity">
						{!activity.isPending && !activity.isError && !activity.data?.items.length ? (
							<EmptyState title={copy.noActivity} description={copy.noActivityDescription} />
						) : null}
						{activity.data?.items.map((event) => (
							<AppView key={event.id} className={webView(ENTITY_CARD_BASE)}>
								<AppText>
									{event.created_at} · {event.direction ?? event.kind} ·{" "}
									{event.delivery_status ?? event.outcome}
								</AppText>
								<AppText selectable>{event.text?.slice(0, 12000)}</AppText>
							</AppView>
						))}
					</TabsContent>
					<TabsContent value="health">
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
					</TabsContent>
					<TabsContent value="commands">
						<WebView recipe={styles.skeletonContent}>
							<ChannelInfoCard icon={KeyRound} title={copy.pairingCommands}>
								{pairingCommandsDescription(
									providerMeta(provider).label,
									supportsPairingCommands(provider),
								)}
							</ChannelInfoCard>
							{supportsPairingCommands(provider) ? (
								<NativeButton
									label={action.busy ? copy.publishing : copy.publishCommands}
									variant="default"
									icon={<Icon as={RefreshCw} />}
									disabled={disabled || !bot?.capabilities.sync_commands}
									onPress={() => {
										let published: components["schemas"]["ChannelCommandSyncResponse"] | null =
											null;
										perform(
											async (signal) => {
												published = await channels.syncCommands(id ?? "", signal);
												return published;
											},
											() => setCommands(published),
										);
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
					</TabsContent>
				</Tabs>
			</AppScrollView>
			{confirmationDialog.dialog}
		</ReadScreen>
	);
}
