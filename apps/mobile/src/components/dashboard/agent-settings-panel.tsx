import {
	AGENT_AVATAR_MIME_TYPES,
	normalizeAgentDisplayName,
	syncAgentNameDraft,
} from "@clawdi/shared/api";
import { agentDisconnectEligibility } from "@clawdi/shared/client";
import { agentsIndexClasses, agentSettingsPanelClasses as styles } from "@clawdi/shared/ui";
import {
	agentDisconnectConfirmationCopy,
	agentDisplayName,
	agentSectionCopy,
	agentSurfaceCopy,
	agentTypeLabel,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { File } from "expo-file-system";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { RotateCcw, Save, Settings as SettingsIcon, Trash2, Upload } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentSourceBadge } from "@/components/dashboard/agent-section-source-badge";
import { useAgentConfirmation } from "@/components/dashboard/confirmation";
import { ActionButton } from "@/components/dashboard/controls";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { PageHeader } from "@/components/page-header";
import { ResourceError } from "@/components/resource-error";
import { SettingsSection } from "@/components/settings-section";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Text as AppText } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { AppScrollView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { type CloudAgent, isNotFound, useCloudAgent } from "@/hooks/cloud-inventory";
import { useAgentOwnership } from "@/hooks/use-agent-ownership";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function AgentSettingsScreen() {
	const params = useLocalSearchParams<{ id?: string | string[] }>();
	const id = routeParam(params.id);
	const scope = useAccountScope();
	return <Settings key={`${scope.accountKey}:${scope.generation}:${id}`} id={id} />;
}

function Settings({ id }: { id: string | undefined }) {
	const t = useI18n();
	const unsavedDialog = useConfirmation();
	const confirmationDialog = useAgentConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const router = useRouter();
	const navigation = useNavigation();
	const cache = useQueryClient();
	const { cloud, agentSettings } = useMobileApi();
	const agent = useCloudAgent(id);
	const [draft, setDraft] = useState("");
	const [disconnected, setDisconnected] = useState(false);
	const previous = useRef<string | undefined>(undefined);
	const confirmation = useRef(0);
	const serverName = agent.data?.display_name ?? "";
	usePreventRemove(
		scope.isReady && !disconnected && previous.current !== undefined && draft !== serverName,
		({ data }) => {
			const visible = capture();
			const ticket = ++confirmation.current;
			unsavedDialog.show(t("agentSettings.unsavedTitle"), t("agentSettings.unsavedMessage"), [
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: t("agentSettings.discard"),
					style: "destructive",
					onPress: () => {
						if (ticket !== confirmation.current || !visible() || !scope.isCurrent()) return;
						confirmation.current++;
						navigation.dispatch(data.action);
					},
				},
			]);
		},
	);
	useEffect(() => {
		if (!agent.data) return;
		const previousName = previous.current;
		setDraft((current) => syncAgentNameDraft(current, previousName, serverName));
		previous.current = serverName;
	}, [serverName, agent.data]);
	const ownership = useAgentOwnership();
	const resolvedOwnership =
		ownership.isError || ownership.isPending ? null : (ownership.data ?? null);
	const canDisconnect = agentDisconnectEligibility({
		platform: "mobile",
		agentId: id,
		explicitIdentity: agent.data?.explicit_identity,
		ownership: resolvedOwnership,
	}).eligible;
	const saveResult = async (result: CloudAgent) => {
		cache.setQueryData(accountQueryKey(scope, "cloud-agent", id), result);
		await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-agents") });
	};
	const unavailable =
		disconnected ||
		action.busy ||
		!scope.isReady ||
		agent.isError ||
		!agent.data ||
		agent.data.id !== id;
	let validName = true;
	let normalized: string | null = null;
	try {
		normalized = normalizeAgentDisplayName(draft);
	} catch {
		validName = false;
	}
	const disconnect = () => {
		if (unavailable || !canDisconnect || !id) return;
		const visible = capture();
		const ticket = ++confirmation.current;
		confirmationDialog.request({
			title: agentDisconnectConfirmationCopy.title,
			description: `${agentDisconnectConfirmationCopy.beforeCommand}${agentDisconnectConfirmationCopy.command}${agentDisconnectConfirmationCopy.afterCommand}`,
			confirmLabel: agentSurfaceCopy.disconnectAgent,
			onConfirm: () => {
				if (
					ticket !== confirmation.current ||
					!visible() ||
					!scope.isCurrent() ||
					scope.signal.aborted
				)
					return;
				return action.runOrThrow(async (current) => {
					const latest = await ownership.refetch();
					if (latest.isError || !latest.data || !current() || !visible())
						throw new Error("Ownership unresolved");
					const currentOwnership = latest.data;
					const fresh = await read((signal) => cloud.getAgent(id, signal));
					if (!current() || !visible()) return;
					if (fresh.id !== id) throw new Error("Agent identity changed");
					await read((signal) =>
						agentSettings.disconnect(
							id,
							{
								platform: "mobile",
								ownership: currentOwnership,
								explicitIdentity: fresh.explicit_identity,
							},
							signal,
						),
					);
					if (!current()) return;
					setDisconnected(true);
					cache.removeQueries({
						queryKey: accountQueryKey(scope, "cloud-agent", id),
						exact: true,
					});
					await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
					if (current() && visible()) router.replace("/agents");
				});
			},
		});
	};
	return (
		<SafeAreaScreen>
			<AppScrollView contentContainerClassName={`${webView(agentsIndexClasses.page)} pt-5 pb-6`}>
				{id ? <AgentSectionNavigation agentId={id} section="settings" /> : null}
				<PageHeader
					icon={<Icon as={SettingsIcon} />}
					title={t("settingsParity.title")}
					description={agentSectionCopy.settings.description}
				/>
				{!id || agent.isError ? <ResourceError missing={!id || isNotFound(agent.error)} /> : null}
				{agent.data && agent.data.id === id ? (
					<WebView recipe={styles.root}>
						<WebView recipe={styles.identity}>
							<AgentIcon
								agent={agent.data.agent_type}
								size="xl"
								avatarUrl={agent.data.avatar_url}
							/>
							<WebView recipe={styles.identityCopy}>
								<WebText recipe={styles.name}>{agentDisplayName(agent.data)}</WebText>
								<WebView recipe={styles.identityMeta} className="flex-row">
									<WebText recipe={styles.errorDescription}>
										{agentTypeLabel(agent.data.agent_type)}
									</WebText>
									<AgentSourceBadge agentId={id} ownership={resolvedOwnership} />
								</WebView>
							</WebView>
						</WebView>
						<SettingsSection
							title={agentSurfaceCopy.name}
							description={agentSurfaceCopy.useAShortNameThatDistinguishesThis}
						>
							<WebView recipe={styles.nameForm}>
								<Input
									accessibilityLabel={t("agentSettings.name")}
									placeholder={t("agentSettings.name")}
									value={draft}
									onChangeText={setDraft}
									maxLength={240}
									editable={!unavailable}
								/>

								<ActionButton
									label={t("composite.save")}
									variant={normalized !== (agent.data.display_name ?? null) ? "default" : "outline"}
									icon={<Icon as={Save} />}
									disabled={
										unavailable || !validName || normalized === (agent.data.display_name ?? null)
									}
									onPress={() =>
										void action.run(async (current) => {
											if (!id) return;
											const result = await read((signal) =>
												agentSettings.setName(id, draft, signal),
											);
											if (!current()) return;
											setDraft(result.display_name ?? "");
											await saveResult(result);
										})
									}
								/>
								<WebText recipe={styles.avatarHint}>
									{t("agentSettings.defaultName")}{" "}
									{agentDisplayName({ ...agent.data, display_name: null })}
								</WebText>
								<ActionButton
									label={t("agentSettings.useDefaultName")}
									className={webView(styles.resetName)}
									icon={<Icon as={RotateCcw} />}
									variant="ghost"
									disabled={unavailable || !agent.data.display_name}
									onPress={() =>
										void action.run(async (current) => {
											if (!id) return;
											const result = await read((signal) => agentSettings.setName(id, "", signal));
											if (!current()) return;
											setDraft(result.display_name ?? "");
											await saveResult(result);
										})
									}
								/>
							</WebView>
						</SettingsSection>
						<SettingsSection
							title={agentSurfaceCopy.avatar}
							description={agentSurfaceCopy.shownInTheSidebarPickersAndAgent}
						>
							<WebView recipe={styles.avatarRow}>
								<WebView recipe={styles.avatarIdentity} className="flex-row">
									<AgentIcon
										agent={agent.data.agent_type}
										size="lg"
										avatarUrl={agent.data.avatar_url}
									/>
									<WebView recipe={styles.avatarCopy}>
										<WebText recipe={styles.avatarLabel}>
											{agent.data.avatar_url
												? agentSurfaceCopy.customUpload
												: t("labels.defaultAgent", { type: agentTypeLabel(agent.data.agent_type) })}
										</WebText>
										<WebText recipe={styles.avatarHint}>{agentSurfaceCopy.imageUpTo2Mb}</WebText>
									</WebView>
								</WebView>
								<WebView recipe={styles.avatarActions} className="flex-row">
									<ActionButton
										label={t("agentSettings.uploadImage")}
										icon={<Icon as={Upload} />}
										disabled={unavailable}
										onPress={() =>
											void action.run(async (current) => {
												if (!id) return;
												const picked = await File.pickFileAsync({
													mimeTypes: [...AGENT_AVATAR_MIME_TYPES],
												});
												// A system picker may change AppState: capture presentation permission
												// after it returns, but retain the original account/action lease.
												const visible = capture();
												if (picked.canceled || !current() || !visible()) return;
												const result = await read((signal) =>
													agentSettings.uploadAvatar(id, picked.result, signal),
												);
												if (current()) await saveResult(result);
											})
										}
									/>
									<ActionButton
										label={t("composite.remove")}
										icon={<Icon as={Trash2} />}
										variant="ghost"
										disabled={unavailable || !agent.data.avatar_url}
										onPress={() =>
											void action.run(async (current) => {
												if (!id) return;
												const result = await read((signal) =>
													agentSettings.clearAvatar(id, signal),
												);
												if (current()) await saveResult(result);
											})
										}
									/>
								</WebView>
							</WebView>
						</SettingsSection>
						{canDisconnect ? (
							<SettingsSection
								title={agentSurfaceCopy.disconnect}
								description={agentSurfaceCopy.stopThisInstallationWhileKeepingItsClawdi}
								destructive
							>
								<WebView recipe={styles.actionRow}>
									<WebText recipe={styles.actionDescription}>
										{agentSurfaceCopy.syncStopsAndRetainedSessionsSkillsFilesAndProjects}
									</WebText>
									<ActionButton
										label={agentSurfaceCopy.disconnectAgent}
										variant="destructive"
										disabled={unavailable || !canDisconnect || ownership.isFetching}
										onPress={disconnect}
									/>
								</WebView>
							</SettingsSection>
						) : null}
					</WebView>
				) : null}
				{action.error ? (
					<AppText accessibilityRole="alert">{t("agentSettings.failed")}</AppText>
				) : null}
			</AppScrollView>
			{confirmationDialog.dialog}
			{unsavedDialog.dialog}
		</SafeAreaScreen>
	);
}
