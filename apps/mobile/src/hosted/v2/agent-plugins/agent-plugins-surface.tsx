import {
	agentPluginActionState,
	agentPluginComponentSummary,
	agentPluginMatches,
	buildAgentPluginInventory,
	type components,
	pluginDisplayName,
} from "@clawdi/shared/api";
import { agentPluginsSurfaceClasses as styles } from "@clawdi/shared/ui";
import { agentSectionCopy, agentSurfaceCopy, identityFor } from "@clawdi/shared/view";
import { focusManager, onlineManager, useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { Blocks } from "lucide-react-native";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentCollection } from "@/components/dashboard/collection";
import { useAgentConfirmation } from "@/components/dashboard/confirmation";
import { ActionButton, ChoiceSelect } from "@/components/dashboard/controls";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS, HeroCard, HeroCardSkeleton } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { SectionLabel } from "@/components/section-label";
import { Icon } from "@/components/ui/icon";
import { Text as AppText } from "@/components/ui/text";
import { WebView } from "@/components/ui/web-layout";
import { canPollDeployment } from "@/hosted/deployment-status";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useHeaderSearch } from "@/platform/navigation/native-header";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function AgentPluginsScreen({ pluginName }: { pluginName?: string } = {}) {
	const params = useLocalSearchParams<{ id?: string | string[] }>();
	const id = routeParam(params.id) ?? "";
	const scope = useAccountScope();
	return (
		<Plugins
			key={`${scope.accountKey}:${scope.generation}:${id}`}
			id={id}
			pluginName={pluginName}
		/>
	);
}

function Plugins({ id, pluginName }: { id: string; pluginName?: string }) {
	const t = useI18n();
	const confirmationDialog = useAgentConfirmation();
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
				if (!hosted) throw new Error(agentSurfaceCopy.unavailable);
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
	const mutate = (name: string, version?: string, guarded = false) =>
		(guarded ? action.runOrThrow : action.run)(async (current) => {
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
		confirmationDialog.request({
			title: t("agentExtensions.pluginRemove"),
			description: t("agentExtensions.pluginRemoveWarning"),
			confirmLabel: t("agentExtensions.pluginRemove"),
			onConfirm: () => {
				if (foreground() && scope.isCurrent() && !signal.aborted)
					return mutate(name, undefined, true);
			},
		});
	};
	const categories = Array.from(new Set(catalog.data?.plugins.map((item) => item.category) ?? []));
	const items = buildAgentPluginInventory(
		catalog.data?.plugins ?? [],
		inventory.data?.plugins ?? [],
	)
		.filter(
			(item) =>
				(!pluginName || item.name === pluginName) &&
				agentPluginMatches(item, search) &&
				(!category || item.catalog?.category === category),
		)
		.map((item) => ({ ...item, id: item.name }));
	const headerSearch = useHeaderSearch({
		value: search,
		onChange: setSearch,
		placeholder: agentSurfaceCopy.searchPlugins,
		maxLength: 200,
	});
	const grouped = [true, false].flatMap((installed) =>
		items.filter((item) => Boolean(item.desired) === installed),
	);
	return (
		<AgentCollection
			data={
				inventory.isPending || catalog.isPending || inventory.isError || catalog.isError
					? []
					: grouped
			}
			keyExtractor={(item) => item.name}
			refreshing={inventory.isRefetching || catalog.isRefetching}
			onRefresh={refresh}
			renderItem={({ item, index }) => {
				const installed = Boolean(item.desired),
					previous = grouped[index - 1];
				const first = !previous || Boolean(previous.desired) !== installed;
				const count = grouped.filter((row) => Boolean(row.desired) === installed).length;
				const state = supportedRuntime ? agentPluginActionState(item, supportedRuntime) : null;
				const kind = state?.primaryAction?.kind ?? "unavailable",
					actionable = kind === "install" || kind === "update" || kind === "retry";
				return (
					<WebView recipe={styles.section}>
						{first ? (
							<SectionLabel count={count}>
								{installed ? agentSurfaceCopy.installed : agentSurfaceCopy.available}
							</SectionLabel>
						) : null}
						<HeroCard
							key={item.name}
							icon={
								<IconChip size="sm" tint={identityFor(item.name).colorClasses}>
									<Icon as={Blocks} />
								</IconChip>
							}
							title={pluginDisplayName(item)}
							description={
								item.catalog?.description ??
								agentSurfaceCopy.thisPluginIsNoLongerAvailableInTheStore
							}
							footer={[
								item.catalog?.publisher,
								state?.version ?? item.desired?.version,
								item.catalog ? agentPluginComponentSummary(item.catalog) : null,
							]}
							footerWrap
							actionsVisibility="always"
							actions={
								<>
									<ActionButton
										label={
											kind === "installed"
												? agentSurfaceCopy.installed
												: kind === "update"
													? "Update"
													: kind === "retry"
														? "Retry"
														: kind === "install"
															? "Install"
															: agentSurfaceCopy.unavailable
										}
										disabled={
											disabled || !actionable || catalog.isFetching || deployments.isFetching
										}
										onPress={() => {
											if (item.catalog && actionable) void mutate(item.name, item.catalog.version);
										}}
									/>
									{item.desired ? (
										<ActionButton
											label={t("composite.remove")}
											variant="ghost"
											disabled={disabled}
											onPress={() => remove(item.name)}
										/>
									) : null}
								</>
							}
						/>
					</WebView>
				);
			}}
			icon={Blocks}
			navigation={id ? <AgentSectionNavigation agentId={id} section="plugins" /> : null}
			title={
				pluginName ? pluginDisplayName(items[0] ?? { name: pluginName }) : agentSurfaceCopy.plugins
			}
			description={agentSectionCopy.plugins.description}
		>
			<Stack.Screen options={{ headerSearchBarOptions: pluginName ? undefined : headerSearch }} />
			<ListToolbar
				filters={
					<ChoiceSelect
						value={category}
						onValueChange={setCategory}
						options={[
							{ value: "", label: t("agentExtensions.allCategories") },
							...categories.map((value) => ({ value, label: value })),
						]}
					/>
				}
			/>
			{action.error ? (
				<ApiErrorPanel error={action.error} title={agentSurfaceCopy.couldnTUpdatePlugin} />
			) : null}
			{accepted ? <AppText>{t("agentExtensions.accepted")}</AppText> : null}
			{inventory.isError || catalog.isError ? (
				<ApiErrorPanel
					error={inventory.error ?? catalog.error}
					title={t("agentExtensions.loadError")}
					onRetry={refresh}
				/>
			) : inventory.isPending || catalog.isPending ? (
				<WebView recipe={HERO_GRID_CLASS}>
					{[0, 1, 2].map((i) => (
						<HeroCardSkeleton key={i} />
					))}
				</WebView>
			) : !items.length ? (
				<EmptyState
					title={agentSurfaceCopy.noPluginsFound}
					description={agentSurfaceCopy.tryADifferentSearchOrCategory}
				/>
			) : null}
			{confirmationDialog.dialog}
		</AgentCollection>
	);
}
