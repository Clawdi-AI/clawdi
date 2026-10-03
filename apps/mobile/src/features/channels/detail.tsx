import {
	agentProviderLinkReplacementRequired,
	agentProviderLinkStatusUnknown,
	type ChannelPairing,
	pairCodeExpired,
	telegramPairDeepLink,
	verifiedDiscordInstallUrl,
	verifiedDiscordPairingCommand,
	verifiedWhatsAppPairLink,
} from "@clawdi/shared/api";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Linking, ScrollView } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { NativeButton, NativePicker, NativeSwitch } from "../../ui/native-controls";
import { AppText, AppView } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { BackButton, useCloudAgents } from "../cloud-inventory";
import { routeParam } from "../read-helpers";
import { useChannelQuery } from "./queries";

export function ChannelDetailScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ id?: string | string[] }>();
	const id = routeParam(params.id);
	return <ChannelDetail key={`${scope.accountKey}:${scope.generation}:${id}`} id={id} />;
}

function ChannelDetail({ id }: { id?: string }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { channels } = useMobileApi();
	const cache = useQueryClient();
	const router = useRouter();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const [agentId, setAgentId] = useState("");
	const [replace, setReplace] = useState(false);
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
	const selected = agents.data?.find((agent) => agent.id === agentId);
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
	const confirm = (title: string, warning: string, operation: () => void) => {
		const visible = capture();
		Alert.alert(title, warning, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: title,
				style: "destructive",
				onPress: () => {
					if (scope.isCurrent() && !scope.signal.aborted && visible()) operation();
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
			<ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
				<BackButton />
				<AppText accessibilityRole="header" className="text-3xl font-semibold text-foreground">
					{bot?.name ?? ownedBot?.name ?? t("channels.title")}
				</AppText>
				{bot ? (
					<AppText>
						{bot.provider} · {bot.status}
					</AppText>
				) : (
					<AppText>{t(pool.isPending ? "loading.app" : "channels.unavailable")}</AppText>
				)}
				<NativeButton
					label={t("channels.refresh")}
					onPress={() =>
						void action.run(async () => {
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
					<AppText accessibilityRole="alert">{t("channels.failed")}</AppText>
				) : null}
				{notice ? <AppText accessibilityRole="alert">{t(`channels.${notice}`)}</AppText> : null}
				<AppText accessibilityRole="header" className="text-xl font-semibold text-foreground">
					{t("channels.links")}
				</AppText>
				{bot?.capabilities.link_agent && bot.available ? (
					<AppView className="gap-3">
						<NativePicker
							value={agentId}
							options={[
								{ value: "", label: t("channels.selectAgent") },
								...(agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
							]}
							disabled={disabled || agents.isError}
							onValueChange={(value) => {
								setAgentId(value);
								setReplace(false);
							}}
						/>
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
						<NativeButton
							label={t("channels.link")}
							disabled={disabled || !selected || unknown || (replacement && !replace)}
							onPress={() =>
								void perform(
									(signal) => channels.link(id ?? "", agentId, replacement && replace, signal),
									() => setReplace(false),
								)
							}
						/>
					</AppView>
				) : null}
				{links.data
					?.filter((link) => link.status === "active")
					.map((link) => (
						<AppView key={link.id} className="gap-3 rounded-2xl bg-surface p-4">
							<AppText selectable>
								{agents.data?.find((agent) => agent.id === link.agent_id)?.name ?? link.agent_id} ·{" "}
								{link.runtime_status}
							</AppText>
							{bot?.capabilities.pair_chat ? (
								<NativeButton
									label={t("channels.pair")}
									disabled={disabled}
									onPress={() =>
										void action.run(async (current) => {
											const visible = capture();
											if (!ready || !visible()) return;
											setPairing(null);
											const code = await read((signal) => channels.pair(id ?? "", link.id, signal));
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
								disabled={disabled}
								onPress={() =>
									confirm(
										t("channels.unlink"),
										t("channels.unlinkWarning"),
										() => void perform((signal) => channels.unlink(id ?? "", link.id, signal)),
									)
								}
							/>
						</AppView>
					))}
				{pairing ? (
					<AppView className="gap-3 rounded-2xl bg-surface p-4">
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
					</AppView>
				) : null}
				<AppText accessibilityRole="header" className="text-xl font-semibold text-foreground">
					{t("channels.bindings")}
				</AppText>
				{bindings.data?.length === 0 ? <AppText>{t("channels.noBindings")}</AppText> : null}
				{bindings.data?.map((binding) => (
					<AppView key={binding.id} className="gap-3 rounded-2xl bg-surface p-4">
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
				{bot?.capabilities.sync_commands ? (
					<NativeButton
						label={t("channels.sync")}
						disabled={disabled}
						onPress={() => void perform((signal) => channels.syncCommands(id ?? "", signal))}
					/>
				) : null}
				{ownedBot ||
				(bot?.access === "owner" && bot.capabilities.manage_account && !pool.isError) ? (
					<NativeButton
						label={t("channels.remove")}
						disabled={disabled}
						onPress={() =>
							confirm(
								t("channels.remove"),
								t("channels.removeWarning"),
								() =>
									void perform(
										(signal) => channels.remove(id ?? "", signal),
										() => router.replace("/channels"),
									),
							)
						}
					/>
				) : null}
				<AppText accessibilityRole="header" className="text-xl font-semibold text-foreground">
					{t("channels.activity")}
				</AppText>
				{activity.data?.items.map((event) => (
					<AppView key={event.id} className="gap-2 rounded-xl bg-surface p-3">
						<AppText>
							{event.created_at} · {event.direction ?? event.kind} ·{" "}
							{event.delivery_status ?? event.outcome}
						</AppText>
						<AppText selectable>{event.text?.slice(0, 12000)}</AppText>
					</AppView>
				))}
			</ScrollView>
		</ReadScreen>
	);
}
