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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { File } from "expo-file-system";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, Image } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton, type CloudAgent, isNotFound, useCloudAgent } from "./cloud-inventory";
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
		Alert.alert(t("agentSettings.disconnect"), t("agentSettings.disconnectWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("agentSettings.disconnect"),
				style: "destructive",
				onPress: () => {
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
			},
		]);
	};
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-4 p-5">
				<BackButton />
				<AppText accessibilityRole="header" className="text-2xl font-semibold text-foreground">
					{t("agentSettings.title")}
				</AppText>
				<NativeButton
					label={t("inventory.refresh")}
					disabled={action.busy || agent.isFetching || ownership.isFetching}
					onPress={() => {
						void agent.refetch();
						void ownership.refetch();
					}}
				/>
				{!id || agent.isError ? <ResourceError missing={!id || isNotFound(agent.error)} /> : null}
				{agent.data && agent.data.id === id ? (
					<AppView className="gap-3">
						{agent.data.avatar_url?.startsWith("https://") ? (
							<Image
								source={{ uri: agent.data.avatar_url }}
								style={{ width: 88, height: 88, borderRadius: 20 }}
								accessibilityLabel={t("agentSettings.avatar")}
							/>
						) : null}
						<AppTextInput
							accessibilityLabel={t("agentSettings.name")}
							placeholder={t("agentSettings.name")}
							value={draft}
							onChangeText={setDraft}
							maxLength={240}
							editable={!unavailable}
							className="rounded-xl bg-card p-3 text-foreground"
						/>
						<AppText>{t("agentSettings.nameHint")}</AppText>
						<NativeButton
							label={t("agentSettings.saveName")}
							disabled={
								unavailable || !validName || normalized === (agent.data.display_name ?? null)
							}
							onPress={() =>
								void action.run(async (current) => {
									if (!id) return;
									const result = await read((signal) => agentSettings.setName(id, draft, signal));
									if (!current()) return;
									setDraft(result.display_name ?? "");
									await saveResult(result);
								})
							}
						/>
						<AppText>{t("agentSettings.avatarHint")}</AppText>
						<NativeButton
							label={t("agentSettings.uploadAvatar")}
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
						<NativeButton
							label={t("agentSettings.clearAvatar")}
							disabled={unavailable || !agent.data.avatar_url}
							onPress={() =>
								void action.run(async (current) => {
									if (!id) return;
									const result = await read((signal) => agentSettings.clearAvatar(id, signal));
									if (current()) await saveResult(result);
								})
							}
						/>
						<AppText>{t("agentSettings.disconnectWarning")}</AppText>
						<NativeButton
							label={t("agentSettings.disconnect")}
							disabled={unavailable || !canDisconnect || ownership.isFetching}
							onPress={disconnect}
						/>
						{!canDisconnect ? <AppText>{t("agentSettings.disconnectUnavailable")}</AppText> : null}
					</AppView>
				) : null}
				{action.error ? (
					<AppText accessibilityRole="alert">{t("agentSettings.failed")}</AppText>
				) : null}
			</AppScrollView>
		</ReadScreen>
	);
}
