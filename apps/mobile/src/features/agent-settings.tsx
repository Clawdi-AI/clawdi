import {
	AGENT_AVATAR_MIME_TYPES,
	normalizeAgentDisplayName,
	syncAgentNameDraft,
} from "@clawdi/shared/api";
import {
	type AgentOwnership,
	agentDisconnectEligibility,
	EMPTY_AGENT_OWNERSHIP,
	normalizeAgentId,
} from "@clawdi/shared/client";
import { agentsIndexClasses, agentSettingsPanelClasses as styles } from "@clawdi/shared/ui";
import { agentDisplayName, agentSurfaceCopy, agentTypeLabel } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { File } from "expo-file-system";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { Settings as SettingsIcon } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { AgentIcon } from "../ui/agents/agent-icon";
import { useAgentConfirmation } from "../ui/agents/confirmation";
import { ActionButton } from "../ui/agents/controls";
import { AgentSectionNavigation } from "../ui/agents/navigation";
import { SettingsSection } from "../ui/agents/settings-section";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { PageHeader } from "../ui/page-header";
import { AppScrollView, AppText } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { WebText, WebView, webView } from "../ui/web-layout";
import { type CloudAgent, isNotFound, useCloudAgent } from "./cloud-inventory";
import { routeParam } from "./read-helpers";
import { ResourceError } from "./resource-error";

export function AgentSettingsScreen() {
	const params = useLocalSearchParams<{ agentId?: string | string[] }>();
	const id = routeParam(params.agentId);
	const scope = useAccountScope();
	return <Settings key={`${scope.accountKey}:${scope.generation}:${id}`} id={id} />;
}

function Settings({ id }: { id: string | undefined }) {
	const t = useI18n();
	const confirmationDialog = useAgentConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const router = useRouter();
	const navigation = useNavigation();
	const cache = useQueryClient();
	const { cloud, agentSettings, hosted, compute } = useMobileApi();
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
			Alert.alert(t("agentSettings.unsavedTitle"), t("agentSettings.unsavedMessage"), [
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
	const ownership = useQuery({
		queryKey: accountQueryKey(scope, "agent-ownership"),
		enabled: scope.isReady,
		retry: false,
		queryFn: ({ signal }) =>
			read(async (lease): Promise<AgentOwnership> => {
				if (!hosted || !compute) return EMPTY_AGENT_OWNERSHIP;
				const [deployments, capabilities] = await Promise.all([
					hosted.listDeployments(lease),
					compute.getProductCapabilities(lease),
				]);
				const legacyIds = capabilities.can_use_v1 ? await compute.getLegacyAgentIds(lease) : [];
				if (
					deployments.some(
						(deployment) => typeof deployment.agent_id !== "string" || !deployment.agent_id.trim(),
					)
				)
					throw new Error("Incomplete Agent ownership");
				const ids = (values: string[]) =>
					new Set(values.map(normalizeAgentId).filter((value): value is string => value !== null));
				return {
					cloudAgentIds: ids(deployments.map((deployment) => deployment.agent_id)),
					legacyAgentIds: ids(legacyIds),
					isResolved: true,
				};
			}, signal),
	});
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
			title: t("agentSettings.disconnect"),
			description: t("agentSettings.disconnectWarning"),
			confirmLabel: t("agentSettings.disconnect"),
			onConfirm: () => {
				if (
					ticket !== confirmation.current ||
					!visible() ||
					!scope.isCurrent() ||
					scope.signal.aborted
				)
					return;
				confirmation.current++;
				void action.run(async (current) => {
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
		<ReadScreen>
			<AppScrollView contentContainerClassName={webView(agentsIndexClasses.page)}>
				{id ? <AgentSectionNavigation agentId={id} section="settings" /> : null}
				<PageHeader
					icon={<Icon as={SettingsIcon} />}
					title="Settings"
					description="Name, preferences, and agent controls."
				/>
				{!id || agent.isError ? <ResourceError missing={!id || isNotFound(agent.error)} /> : null}
				{agent.data && agent.data.id === id ? (
					<WebView recipe="">
						<WebView recipe={styles.flexFlexColItems}>
							<AgentIcon
								agent={agent.data.agent_type}
								size="xl"
								avatarUrl={agent.data.avatar_url}
							/>
							<WebText recipe={styles.maxWFullTruncate}>{agentDisplayName(agent.data)}</WebText>
							<WebText recipe={styles.textSmTextMuted}>
								{agentTypeLabel(agent.data.agent_type)} · Connected
							</WebText>
						</WebView>
						<SettingsSection
							title={agentSurfaceCopy.name}
							description={agentSurfaceCopy.useAShortNameThatDistinguishesThis}
						>
							<WebView recipe={styles.flexWFullFlex}>
								<Input
									accessibilityLabel={t("agentSettings.name")}
									placeholder={t("agentSettings.name")}
									value={draft}
									onChangeText={setDraft}
									maxLength={240}
									editable={!unavailable}
								/>
								<WebText recipe={styles.textXsTextMuted}>
									Default: {agentDisplayName({ ...agent.data, display_name: null })}
								</WebText>
								<ActionButton
									label="Save"
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
								<ActionButton
									label="Use default name"
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
							<WebView recipe={styles.flexFlexColGap3}>
								<WebView recipe={styles.flexMinWFlex2} className="flex-row">
									<AgentIcon
										agent={agent.data.agent_type}
										size="lg"
										avatarUrl={agent.data.avatar_url}
									/>
									<WebView recipe={styles.minW}>
										<WebText recipe={styles.truncateTextSmFont}>
											{agent.data.avatar_url
												? agentSurfaceCopy.customUpload
												: `${agentTypeLabel(agent.data.agent_type)} default`}
										</WebText>
										<WebText recipe={styles.textXsTextMuted}>
											{agentSurfaceCopy.imageUpTo2Mb}
										</WebText>
									</WebView>
								</WebView>
								<WebView recipe={styles.flexShrinkFlexWrap} className="flex-row">
									<ActionButton
										label="Upload image"
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
										label="Remove"
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
								<WebView recipe={styles.flexFlexColGap4}>
									<WebText recipe={styles.maxWMdText}>
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
		</ReadScreen>
	);
}
