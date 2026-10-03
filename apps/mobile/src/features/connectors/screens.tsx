import {
	buildCredentialPayload,
	type components,
	getConnectorAuthFlow,
	getVisibleCredentialFields,
	isActiveConnection,
	safeShareUrl,
} from "@clawdi/shared/api";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import { useCallback, useEffect, useState } from "react";
import { Alert, AppState } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { ErrorState, LoadingScreen } from "../../ui/feedback";
import { NativeButton } from "../../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../../ui/primitives";
import { InventoryList } from "../inventory-list";
import { routeParam } from "../read-helpers";

type Connection = components["schemas"]["ConnectorConnectionResponse"];

function useConnections() {
	const scope = useAccountScope();
	const read = useAccountRead();
	const { connectors } = useMobileApi();
	const query = useQuery({
		queryKey: accountQueryKey(scope, "connectors"),
		queryFn: ({ signal }) => read((s) => connectors.list(s), signal),
		enabled: scope.isReady,
		retry: false,
	});
	const { refetch } = query;
	useFocusEffect(
		useCallback(() => {
			if (scope.isReady && scope.isCurrent()) void refetch();
			const listener = AppState.addEventListener("change", (state) => {
				if (state === "active" && scope.isReady && scope.isCurrent()) void refetch();
			});
			return () => listener.remove();
		}, [scope, refetch]),
	);
	return query;
}

export function ConnectorCatalogScreen() {
	const scope = useAccountScope();
	return <Catalog key={`${scope.identity}:${scope.generation}`} />;
}

function Catalog() {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { connectors } = useMobileApi();
	const [draft, setDraft] = useState("");
	const [search, setSearch] = useState("");
	const [showAccounts, setShowAccounts] = useState(false);
	const connections = useConnections();
	const catalog = useInfiniteQuery({
		queryKey: accountQueryKey(scope, "connector-catalog", search),
		initialPageParam: 1,
		queryFn: ({ pageParam, signal }) =>
			read(
				(s) =>
					connectors.catalog({ page: pageParam, page_size: 24, search: search || undefined }, s),
				signal,
			),
		getNextPageParam: (page) =>
			page.items.length && page.page * page.page_size < page.total ? page.page + 1 : undefined,
		enabled: scope.isReady && !showAccounts,
		retry: false,
	});
	const apps = Array.from(
		new Map(
			(catalog.data?.pages.flatMap((page) => page.items) ?? []).map((app) => [app.name, app]),
		).values(),
	);
	const query = showAccounts ? connections : catalog;
	const rows = showAccounts
		? (connections.data ?? []).map((c) => ({
				id: c.id,
				name: c.app_name,
				title: c.alias || c.account_display || c.app_name,
				description: `${c.status} · ${t(isActiveConnection(c) ? "connectors.active" : "connectors.inactive")}`,
			}))
		: apps.map((app) => ({
				id: app.name,
				name: app.name,
				title: app.display_name,
				description: app.description,
			}));
	return (
		<InventoryList
			title={t("connectors.title")}
			description={t("connectors.description")}
			items={rows}
			empty={t(query.isPending ? "loading.app" : "connectors.empty")}
			refreshing={query.isRefetching}
			onRefresh={() => {
				if (!query.isFetching) void query.refetch();
			}}
			error={query.isError}
			onRetry={() => void query.refetch()}
			busy={query.isFetching}
			more={!showAccounts && catalog.hasNextPage}
			onMore={() => {
				if (!catalog.isFetching) void catalog.fetchNextPage();
			}}
			header={
				<AppView className="gap-3">
					<NativeButton
						label={t(showAccounts ? "connectors.catalog" : "connectors.accounts")}
						onPress={() => setShowAccounts(!showAccounts)}
					/>
					{!showAccounts ? (
						<>
							<AppTextInput
								className="rounded-xl bg-surface p-3 text-foreground"
								accessibilityLabel={t("connectors.search")}
								placeholder={t("connectors.search")}
								value={draft}
								onChangeText={setDraft}
								maxLength={200}
								onSubmitEditing={() => setSearch(draft.trim())}
							/>
							<NativeButton
								label={t("connectors.search")}
								onPress={() => setSearch(draft.trim())}
							/>
						</>
					) : null}
				</AppView>
			}
			renderItem={(item) => (
				<AppView className="gap-2 rounded-2xl bg-surface p-4">
					<AppText className="text-lg font-semibold text-foreground">{item.title}</AppText>
					<AppText className="text-muted">{item.description}</AppText>
					<NativeButton
						label={t("inventory.viewAll")}
						onPress={() =>
							router.push({ pathname: "/connectors/[appName]", params: { appName: item.name } })
						}
					/>
				</AppView>
			)}
		/>
	);
}

export function ConnectorDetailScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ appName?: string | string[] }>();
	const name = routeParam(params.appName);
	return <Detail key={`${scope.identity}:${scope.generation}:${name}`} name={name} />;
}

function Detail({ name }: { name?: string }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const cache = useQueryClient();
	const { connectors } = useMobileApi();
	const action = useAuthAction(scope);
	const capture = useForegroundLease();
	const [values, setValues] = useState<Record<string, string>>({});
	const [alias, setAlias] = useState("");
	useFocusEffect(useCallback(() => () => setValues({}), []));
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") setValues({});
		});
		return () => listener.remove();
	}, []);
	const app = useQuery({
		queryKey: accountQueryKey(scope, "connector-app", name),
		queryFn: ({ signal }) => read((s) => connectors.getApp(name ?? "", s), signal),
		enabled: scope.isReady && Boolean(name),
		retry: false,
	});
	const flow = getConnectorAuthFlow(app.data?.auth_type);
	const fields = useQuery({
		queryKey: accountQueryKey(scope, "connector-fields", name),
		queryFn: ({ signal }) => read((s) => connectors.authFields(name ?? "", s), signal),
		enabled: scope.isReady && Boolean(name) && flow === "credentials",
		retry: false,
		gcTime: 0,
	});
	const tools = useQuery({
		queryKey: accountQueryKey(scope, "connector-tools", name),
		queryFn: ({ signal }) => read((s) => connectors.tools(name ?? "", s), signal),
		enabled: scope.isReady && Boolean(name),
		retry: false,
	});
	const accounts = useConnections();
	const visibleFields = getVisibleCredentialFields(fields.data?.expected_input_fields ?? []);
	const fieldValue = (key: string) => (Object.hasOwn(values, key) ? (values[key] ?? "") : "");
	const canConnect = Boolean(
		name &&
			app.data &&
			!app.isError &&
			!app.data.connect_disabled &&
			(flow === "redirect" ||
				(flow === "credentials" &&
					!fields.isError &&
					visibleFields.length &&
					visibleFields.every((field) => !field.required || fieldValue(field.name).trim()))),
	);
	const refresh = () => cache.invalidateQueries({ queryKey: accountQueryKey(scope, "connectors") });
	const connect = () => {
		const visible = capture();
		void action.run(async (isCurrent) => {
			if (!name || !canConnect || !visible()) return;
			if (flow === "credentials") {
				const credentials = buildCredentialPayload(
					fields.data?.expected_input_fields ?? [],
					values,
				);
				setValues({});
				const result = await read((s) =>
					connectors.connectCredentials(name, { credentials, alias: alias.trim() || undefined }, s),
				);
				if (!isCurrent()) return;
				await refresh();
				if (!result.ok) throw new Error("Connector rejected credentials");
			} else if (flow === "redirect") {
				// No custom-scheme callback: server supports provider-managed callbacks when omitted.
				const result = await read((s) =>
					connectors.connect(name, { alias: alias.trim() || undefined }, s),
				);
				if (!isCurrent() || !visible()) return;
				const url = safeShareUrl(result.connect_url);
				if (!url) throw new Error("Invalid connector authorization URL");
				await openBrowserAsync(url);
				if (isCurrent()) await refresh();
			}
		});
	};
	return (
		<InventoryList
			title={app.data?.display_name || name || t("connectors.title")}
			description={app.data?.description || t("connectors.description")}
			items={(tools.data ?? []).map((tool) => ({ ...tool, id: tool.name }))}
			empty={t(tools.isPending ? "loading.app" : "connectors.noTools")}
			refreshing={tools.isRefetching || accounts.isRefetching || app.isRefetching}
			onRefresh={() => {
				if (name) {
					void tools.refetch();
					void app.refetch();
					void accounts.refetch();
				}
			}}
			error={!name || app.isError || tools.isError}
			onRetry={() => {
				if (name) {
					void app.refetch();
					void tools.refetch();
				}
			}}
			header={
				<AppView className="gap-4">
					{app.isPending && name ? <LoadingScreen /> : null}
					{flow === "no_auth" ? (
						<AppText className="text-muted">{t("connectors.ready")}</AppText>
					) : app.data && (!flow || app.data.connect_disabled) ? (
						<AppText className="text-muted">{t("connectors.unavailable")}</AppText>
					) : app.data ? (
						<AppView className="gap-3">
							<AppText className="text-muted">
								{t(flow === "redirect" ? "connectors.oauth" : "connectors.credentials")}
							</AppText>
							<AppTextInput
								accessibilityLabel={t("connectors.alias")}
								placeholder={t("connectors.alias")}
								className="rounded-xl bg-surface p-3 text-foreground"
								value={alias}
								onChangeText={setAlias}
								maxLength={256}
								editable={!action.busy}
							/>
							{flow === "credentials" ? (
								fields.isPending ? (
									<LoadingScreen />
								) : fields.isError ? (
									<ErrorState onRetry={() => void fields.refetch()} />
								) : (
									visibleFields.map((field) => (
										<AppView key={field.name} className="gap-1">
											<AppText className="text-foreground">
												{field.display_name || field.name}
												{field.required ? ` · ${t("connectors.required")}` : ""}
											</AppText>
											<AppTextInput
												accessibilityLabel={field.display_name || field.name}
												className="rounded-xl bg-surface p-3 text-foreground"
												secureTextEntry={field.is_secret}
												autoCorrect={false}
												autoCapitalize="none"
												autoComplete="off"
												maxLength={8192}
												value={fieldValue(field.name)}
												onChangeText={(value) =>
													setValues((old) => ({ ...old, [field.name]: value }))
												}
												editable={!action.busy}
											/>
											{field.description ? (
												<AppText className="text-muted">{field.description}</AppText>
											) : null}
										</AppView>
									))
								)
							) : null}
							<NativeButton
								label={t("connectors.connect")}
								disabled={action.busy || !canConnect}
								onPress={connect}
							/>
						</AppView>
					) : null}
					{action.error ? (
						<AppText accessibilityRole="alert" className="text-danger">
							{t("connectors.failed")}
						</AppText>
					) : null}
					<AppText className="text-xl font-semibold text-foreground">
						{t("connectors.accounts")}
					</AppText>
					<NativeButton
						label={t("connectors.refresh")}
						disabled={accounts.isFetching}
						onPress={() => void accounts.refetch()}
					/>
					{accounts.isPending ? (
						<LoadingScreen />
					) : accounts.isError ? (
						<ErrorState onRetry={() => void accounts.refetch()} />
					) : accounts.data?.some((c) => c.app_name === name) ? (
						accounts.data
							.filter((c) => c.app_name === name)
							.map((connection) => <Account key={connection.id} connection={connection} />)
					) : (
						<AppText className="text-muted">{t("connectors.noAccounts")}</AppText>
					)}
					<AppText className="text-xl font-semibold text-foreground">
						{t("connectors.tools")}
					</AppText>
				</AppView>
			}
			renderItem={(tool) => (
				<AppView className="gap-2 rounded-2xl bg-surface p-4">
					<AppText className="text-lg text-foreground">{tool.display_name || tool.name}</AppText>
					<AppText selectable className="text-muted">
						{tool.name}
					</AppText>
					<AppText className="text-foreground">{tool.description}</AppText>
					{tool.is_deprecated ? (
						<AppText className="text-muted">{t("connectors.deprecated")}</AppText>
					) : null}
					{tool.parameters ? (
						<AppText selectable className="text-muted">
							{JSON.stringify(tool.parameters, null, 2)}
						</AppText>
					) : null}
				</AppView>
			)}
		/>
	);
}

function Account({ connection }: { connection: Connection }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const cache = useQueryClient();
	const { connectors } = useMobileApi();
	const action = useAuthAction(scope);
	const capture = useForegroundLease();
	const [alias, setAlias] = useState(connection.alias ?? "");
	const update = (disconnect: boolean) => {
		const visible = capture();
		const perform = () => {
			if (!visible() || !scope.isCurrent()) return;
			void action.run(async (isCurrent) => {
				if (disconnect) await read((s) => connectors.disconnect(connection.id, s));
				else await read((s) => connectors.update(connection.id, { alias: alias.trim() }, s));
				if (isCurrent())
					await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "connectors") });
			});
		};
		if (!disconnect) perform();
		else
			Alert.alert(t("connectors.disconnect"), t("connectors.disconnectWarning"), [
				{ text: t("account.cancel"), style: "cancel" },
				{ text: t("connectors.disconnect"), style: "destructive", onPress: perform },
			]);
	};
	return (
		<AppView className="gap-2 rounded-2xl bg-surface p-4">
			<AppText className="text-foreground">
				{connection.account_display || connection.alias || connection.id} · {connection.status}
			</AppText>
			<AppText className="text-muted">
				{t(isActiveConnection(connection) ? "connectors.active" : "connectors.inactive")}
			</AppText>
			<AppTextInput
				accessibilityLabel={t("connectors.alias")}
				className="rounded-xl bg-background p-3 text-foreground"
				value={alias}
				onChangeText={setAlias}
				maxLength={256}
				editable={!action.busy}
			/>
			<NativeButton
				label={t("connectors.saveAlias")}
				disabled={action.busy || alias.trim() === (connection.alias ?? "")}
				onPress={() => update(false)}
			/>
			<NativeButton
				label={t("connectors.disconnect")}
				disabled={action.busy}
				onPress={() => update(true)}
			/>
			{action.error ? (
				<AppText accessibilityRole="alert" className="text-danger">
					{t("connectors.failed")}
				</AppText>
			) : null}
		</AppView>
	);
}
