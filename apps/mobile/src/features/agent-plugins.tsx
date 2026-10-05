import {
	agentPluginActionState,
	agentPluginMatches,
	buildAgentPluginInventory,
	type components,
	pluginDisplayName,
} from "@clawdi/shared/api";
import { focusManager, onlineManager, useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton, NativePicker } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";
import { canPollDeployment } from "./deployments/state";
import { InventoryList } from "./inventory-list";
import { routeParam } from "./read-helpers";

export function AgentPluginsScreen() {
	const params = useLocalSearchParams<{ agentId?: string | string[] }>();
	const id = routeParam(params.agentId) ?? "";
	const scope = useAccountScope();
	return <Plugins key={`${scope.accountKey}:${scope.generation}:${id}`} id={id} />;
}

function Plugins({ id }: { id: string }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const { agentExtensions: client, hosted } = useMobileApi();
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState("");
	const [accepted, setAccepted] = useState(false);
	const [startedAt, setStartedAt] = useState(Date.now);
	const focused = useIsFocused();
	const catalog = useQuery({
		queryKey: accountQueryKey(scope, "plugin-catalog"),
		enabled: scope.isReady,
		retry: false,
		queryFn: ({ signal }) => read((lease) => client.catalog(lease), signal),
	});
	const deployments = useQuery({
		queryKey: accountQueryKey(scope, "deployments"),
		enabled: Boolean(hosted && scope.isReady),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!hosted) throw new Error("Unavailable");
				return hosted.listDeployments(lease);
			}, signal),
	});
	const inventory = useQuery<components["schemas"]["AgentPluginDesiredStateListResponse"]>({
		queryKey: accountQueryKey(scope, "agent-plugins", id),
		enabled: Boolean(id && scope.isReady),
		retry: false,
		queryFn: ({ signal }) => read((lease) => client.listPlugins(id, lease), signal),
		refetchInterval: (query) =>
			focused &&
			!query.state.error &&
			query.state.data?.plugins.some((item) => item.convergence === "not_observed") &&
			canPollDeployment(startedAt, Date.now(), focusManager.isFocused(), onlineManager.isOnline())
				? 5000
				: false,
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const matches =
		deployments.data?.filter(
			(item) =>
				item.agent_id === id &&
				item.resource.spec.desired_lifecycle !== "deleted" &&
				item.resource.status?.summary_state !== "deleted",
		) ?? [];
	const runtime =
		matches.length === 1 && !deployments.isError ? matches[0]?.resource.spec.runtime : undefined;
	const supportedRuntime = runtime === "openclaw" || runtime === "hermes" ? runtime : undefined;
	const disabled =
		action.busy || !id || inventory.isError || !inventory.data || inventory.isFetching;
	const refresh = () => {
		setStartedAt(Date.now());
		void inventory.refetch();
		void catalog.refetch();
		if (hosted) void deployments.refetch();
	};
	const mutate = (name: string, version?: string) =>
		action.run(async (current) => {
			if (
				disabled ||
				(version !== undefined && (!supportedRuntime || catalog.isError || deployments.isFetching))
			)
				return;
			await read(async (signal) => {
				if (version === undefined) await client.removePlugin(id, name, signal);
				else await client.installPlugin(id, name, version, signal);
			});
			if (!current()) return;
			setAccepted(true);
			setStartedAt(Date.now());
			await inventory.refetch();
		});
	const remove = (name: string) => {
		const foreground = capture();
		const signal = scope.signal;
		Alert.alert(t("agentExtensions.pluginRemove"), t("agentExtensions.pluginRemoveWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("agentExtensions.pluginRemove"),
				style: "destructive",
				onPress: () => {
					if (foreground() && scope.isCurrent() && !signal.aborted) void mutate(name);
				},
			},
		]);
	};
	const categories = Array.from(new Set(catalog.data?.plugins.map((item) => item.category) ?? []));
	const items = buildAgentPluginInventory(
		catalog.data?.plugins ?? [],
		inventory.data?.plugins ?? [],
	)
		.filter(
			(item) =>
				agentPluginMatches(item, search) && (!category || item.catalog?.category === category),
		)
		.map((item) => ({ ...item, id: item.name }));
	return (
		<InventoryList
			title={t("agentExtensions.plugins")}
			description={t("agentExtensions.pluginDescription")}
			items={items}
			empty={t(inventory.isPending ? "loading.app" : "agentExtensions.empty")}
			refreshing={inventory.isRefetching || catalog.isRefetching}
			onRefresh={refresh}
			onRetry={refresh}
			error={!id || inventory.isError || catalog.isError || Boolean(hosted && deployments.isError)}
			busy={inventory.isFetching || catalog.isFetching || deployments.isFetching}
			header={
				<AppView className="gap-3">
					<AppTextInput
						accessibilityLabel={t("agentExtensions.pluginSearch")}
						placeholder={t("agentExtensions.pluginSearch")}
						value={search}
						onChangeText={setSearch}
					/>
					<NativePicker
						value={category}
						onValueChange={setCategory}
						options={[
							{ value: "", label: t("agentExtensions.all") },
							...categories.map((value) => ({ value, label: value })),
						]}
					/>
					{!supportedRuntime ? <AppText>{t("agentExtensions.unavailable")}</AppText> : null}
					{accepted ? <AppText>{t("agentExtensions.accepted")}</AppText> : null}
					{action.error ? (
						<AppText accessibilityRole="alert">{t("agentExtensions.failed")}</AppText>
					) : null}
				</AppView>
			}
			renderItem={(item) => {
				const state = supportedRuntime ? agentPluginActionState(item, supportedRuntime) : null;
				const kind = state?.primaryAction?.kind ?? "unavailable";
				const actionable = kind === "install" || kind === "update" || kind === "retry";
				const label =
					kind === "installed" ? "pluginInstalled" : kind === "failed" ? "pluginFailed" : kind;
				return (
					<AppView className="gap-3 rounded-2xl bg-card p-4">
						<AppText className="text-lg text-foreground">{pluginDisplayName(item)}</AppText>
						<AppText>{state?.version ?? item.desired?.version ?? item.catalog?.version}</AppText>
						<AppText>{item.catalog?.description}</AppText>
						{item.desired ? (
							<AppText>
								{t(
									item.desired.convergence === "installed"
										? "agentExtensions.installed"
										: item.desired.convergence === "failed"
											? "agentExtensions.failedState"
											: "agentExtensions.not_observed",
								)}
							</AppText>
						) : null}
						{item.catalog ? (
							<>
								<AppText>
									{item.catalog.publisher} · {item.catalog.category}
								</AppText>
								<AppText>
									{t("agentExtensions.components")}:{" "}
									{[
										...item.catalog.components.skills,
										...Object.keys(item.catalog.components.mcpServers),
									].join(", ")}
								</AppText>
							</>
						) : null}
						<NativeButton
							label={t(`agentExtensions.${label}`)}
							disabled={
								disabled ||
								!actionable ||
								catalog.isError ||
								catalog.isFetching ||
								deployments.isFetching
							}
							onPress={() => {
								if (actionable && item.catalog) void mutate(item.name, item.catalog.version);
							}}
						/>
						{item.desired ? (
							<NativeButton
								label={t("agentExtensions.pluginRemove")}
								disabled={disabled}
								onPress={() => remove(item.name)}
							/>
						) : null}
					</AppView>
				);
			}}
		/>
	);
}
