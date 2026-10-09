import {
	buildCredentialPayload,
	type components,
	filterConnectorTools,
	getConnectorAuthFlow,
	getVisibleCredentialFields,
	isActiveConnection,
	safeShareUrl,
} from "@clawdi/shared/api";
import {
	accountAliasFieldClasses,
	connectorDetailClasses,
	connectorsSurfaceClasses,
	credentialsDialogClasses,
	memoryDetailClasses,
} from "@clawdi/shared/ui";
import {
	connectorConnectTitle,
	connectorDisconnectTitle,
	connectorFormCopy as copy,
	getProjectResourceDefinition,
} from "@clawdi/shared/view";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import Check from "lucide-react-native/icons/check";
import Plug from "lucide-react-native/icons/plug";
import Unplug from "lucide-react-native/icons/unplug";
import Wrench from "lucide-react-native/icons/wrench";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { ConnectorCard } from "@/components/connectors/connector-card";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { DashboardSection, DashboardSectionHeader } from "@/components/dashboard/section";
import { EmptyState } from "@/components/empty-state";
import { EntityCardSkeleton } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { ErrorState } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { NativeList } from "@/components/ui/native-list";
import { SheetPage } from "@/components/ui/sheet-page";
import { Skeleton } from "@/components/ui/skeleton";
import { Text as AppText, Text } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { WebText, WebView, webText, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useHeaderSearch } from "@/platform/navigation/native-header";
import { useSheet } from "@/platform/navigation/use-sheet";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

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

	const [search, setSearch] = useState("");

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
		enabled: scope.isReady,
		retry: false,
	});
	const apps = Array.from(
		new Map(
			(catalog.data?.pages.flatMap((page) => page.items) ?? []).map((app) => [app.name, app]),
		).values(),
	);
	const connectedNames = [
		...new Set((connections.data ?? []).filter(isActiveConnection).map((c) => c.app_name)),
	];
	const metadata = useQueries({
		queries: connectedNames.map((name) => ({
			queryKey: accountQueryKey(scope, "connector-app", name),
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				read((s) => connectors.getApp(name, s), signal),
			enabled: scope.isReady,
			retry: false,
		})),
	});
	const total = catalog.data?.pages[0]?.total ?? 0;
	const open = (name: string) =>
		router.push({ pathname: "/connectors/[name]", params: { name: name } });

	const searchOptions = useHeaderSearch({
		value: search,
		onChange: setSearch,
		placeholder: t("libraryPort.searchConnectors"),
	});
	const connectedCells =
		!search && !connections.error
			? connectedNames.map((name, i) => {
					const app = metadata[i]?.data ?? apps.find((app) => app.name === name);
					return app ? (
						<ConnectorCard key={`connected-${name}`} app={app} isConnected />
					) : metadata[i]?.error ? (
						<ApiErrorPanel
							key={`connected-error-${name}`}
							error={metadata[i]?.error}
							onRetry={() => void metadata[i]?.refetch()}
						/>
					) : (
						<EntityCardSkeleton key={`connected-loading-${name}`} />
					);
				})
			: [];
	const cells = [
		...(!search && (connectedNames.length || connections.error)
			? [
					<WebView recipe={connectorsSurfaceClasses.section} key="connected-heading">
						<SectionLabel count={`${connectedNames.length} apps`}>
							{t("libraryPort.yourConnections")}
						</SectionLabel>
						{connections.error ? (
							<ApiErrorPanel error={connections.error} onRetry={() => void connections.refetch()} />
						) : null}
					</WebView>,
					...connectedCells,
				]
			: []),
		<SectionLabel key="catalog-heading" count={`${total} available`}>
			{t("libraryPort.allConnectors")}
		</SectionLabel>,
		...apps.map((app) => (
			<ConnectorCard
				key={`catalog-${app.name}`}
				app={app}
				isConnected={connectedNames.includes(app.name)}
				searchQuery={search}
				actions={
					!connectedNames.includes(app.name) ? (
						<Button size="sm" variant="outline" onPress={() => open(app.name)}>
							<Icon as={Plug} />
							<Text>{t("libraryPort.connect")}</Text>
						</Button>
					) : undefined
				}
			/>
		)),
	];
	return (
		<SafeAreaScreen>
			<Stack.Screen
				options={{ headerSearchBarOptions: searchOptions, headerLargeTitleEnabled: true }}
			/>
			<NativeList
				data={cells}
				keyExtractor={(cell, index) => String(cell.key ?? index)}
				renderItem={({ item }) => item}
				refreshing={catalog.isRefetching || connections.isRefetching}
				onRefresh={() => {
					void catalog.refetch();
					void connections.refetch();
				}}
				hasMore={catalog.hasNextPage}
				loadingMore={catalog.isFetching}
				onLoadMore={() => void catalog.fetchNextPage().catch(() => undefined)}
				header={
					<>
						<PageHeader
							title={t("connectors.title")}
							description={getProjectResourceDefinition("connectors").managementDescription}
							status={
								<WebView recipe={connectorsSurfaceClasses.filters}>
									<Badge variant="secondary">
										<Text>
											{total} {t("connectors.availableCount")}
										</Text>
									</Badge>
									<Badge>
										<Text>
											{connectedNames.length} {t("connectors.activeCount")}
										</Text>
									</Badge>
								</WebView>
							}
						/>
						{catalog.error ? (
							<ApiErrorPanel error={catalog.error} onRetry={() => void catalog.refetch()} />
						) : null}
					</>
				}
				footer={
					catalog.isPending ? (
						<EntityCardSkeleton />
					) : !catalog.error && !apps.length ? (
						<EmptyState title={t("libraryPort.noConnectors")} />
					) : null
				}
			/>
		</SafeAreaScreen>
	);
}

export function ConnectorDetailScreen({ form = false }: { form?: boolean } = {}) {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ name?: string | string[] }>();
	const name = routeParam(params.name);
	return <Detail key={`${scope.identity}:${scope.generation}:${name}`} name={name} form={form} />;
}

function Detail({ name, form }: { name?: string; form: boolean }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const cache = useQueryClient();
	const { connectors } = useMobileApi();
	const action = useAuthAction(scope);
	const capture = useForegroundLease();
	const [values, setValues] = useState<Record<string, string>>({});
	const [alias, setAlias] = useState("");
	const [closeError, setCloseError] = useState<unknown>();
	const sheet = useSheet<boolean>({ fallback: "/connectors", busy: action.busy });
	const [toolSearch, setToolSearch] = useState("");
	const deferredToolSearch = useDeferredValue(toolSearch);
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
	const filteredTools = useMemo(
		() =>
			filterConnectorTools(tools.data ?? [], deferredToolSearch).map((tool) => ({
				...tool,
				id: tool.name,
			})),
		[tools.data, deferredToolSearch],
	);
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
				if (isCurrent() && visible()) await sheet.close(true);
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
	const appAccounts = (accounts.data ?? []).filter((c) => c.app_name === name);
	const connected = appAccounts.some(isActiveConnection);
	const ready = connected || flow === "no_auth";

	const searchOptions = useHeaderSearch({
		value: toolSearch,
		onChange: setToolSearch,
		placeholder: t("libraryPort.tools"),
	});
	if (form)
		return (
			<SheetPage
				title={connectorConnectTitle(app.data?.display_name ?? name ?? "")}
				description={flow === "credentials" ? copy.credentialsDescription : undefined}
				fallback="/connectors"
				busy={action.busy}
				sheet={sheet}
			>
				<WebView recipe={credentialsDialogClasses.body}>
					{flow === "no_auth" ? (
						<AppText className="text-muted-foreground">{t("connectors.ready")}</AppText>
					) : app.data && (!flow || app.data.connect_disabled) ? (
						<AppText className="text-muted-foreground">{t("connectors.unavailable")}</AppText>
					) : app.data ? (
						<WebView recipe={credentialsDialogClasses.form}>
							{flow === "redirect" ? (
								<AppText className="text-muted-foreground">{t("connectors.oauth")}</AppText>
							) : null}
							{flow === "credentials" ? (
								fields.isPending ? (
									<Skeleton className={webView(connectorDetailClasses.accountTitleSkeleton)} />
								) : fields.isError ? (
									<ErrorState onRetry={() => void fields.refetch()} />
								) : !visibleFields.length ? (
									<WebText recipe={credentialsDialogClasses.empty}>{copy.credentialsEmpty}</WebText>
								) : (
									visibleFields.map((field) => (
										<WebView key={field.name} recipe={credentialsDialogClasses.field}>
											<Label>
												{field.display_name || field.name}
												{field.required ? (
													<WebText recipe={credentialsDialogClasses.required}>*</WebText>
												) : null}
											</Label>
											<Input
												accessibilityLabel={field.display_name || field.name}
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
												<WebText recipe={credentialsDialogClasses.hint}>
													{field.description}
												</WebText>
											) : null}
										</WebView>
									))
								)
							) : null}
							{flow === "redirect" ||
							(!fields.isPending && !fields.isError && visibleFields.length) ? (
								<ConnectorAliasField value={alias} onChange={setAlias} disabled={action.busy} />
							) : null}
						</WebView>
					) : null}
					{action.error ? <ApiErrorPanel error={action.error} /> : null}
				</WebView>
				<WebView recipe={credentialsDialogClasses.body}>
					<Button
						variant="outline"
						disabled={action.busy}
						onPress={() => void sheet.close().catch(setCloseError)}
					>
						<Text>{copy.cancel}</Text>
					</Button>
					<Button variant="default" disabled={action.busy || !canConnect} onPress={connect}>
						<Text>{copy.connect}</Text>
					</Button>
				</WebView>
				{closeError ? <ApiErrorPanel error={closeError} /> : null}
			</SheetPage>
		);
	const cells = [
		...appAccounts.map((c) => <Account key={`account-${c.id}`} connection={c} />),
		<WebView recipe={connectorDetailClasses.toolList} key="tools-heading">
			<DashboardSection>
				<DashboardSectionHeader
					icon={Wrench}
					title={t("libraryPort.tools")}
					count={`${tools.data?.length ?? 0} tools`}
					description={t("libraryPort.toolsDescription")}
				/>
				{tools.error ? (
					<ApiErrorPanel error={tools.error} onRetry={() => void tools.refetch()} />
				) : tools.isPending ? (
					<EntityCardSkeleton />
				) : (
					<WebView recipe={connectorDetailClasses.toolList}></WebView>
				)}
			</DashboardSection>
		</WebView>,
		...filteredTools.map((tool, index) => (
			<WebView
				key={`tool-${tool.name}`}
				recipe={`${connectorDetailClasses.toolRow} ${index ? "border-t" : ""}`}
			>
				<WebView recipe={connectorDetailClasses.toolBody}>
					<WebView recipe={connectorDetailClasses.toolHeading}>
						<WebText recipe={connectorDetailClasses.title}>
							{tool.display_name || tool.name}
						</WebText>
					</WebView>
					<WebText recipe={connectorDetailClasses.toolDescription}>{tool.description}</WebText>
				</WebView>
			</WebView>
		)),
	];
	return (
		<SafeAreaScreen>
			<Stack.Screen options={{ headerSearchBarOptions: searchOptions }} />
			<NativeList
				data={cells}
				keyExtractor={(cell, index) => String(cell.key ?? index)}
				renderItem={({ item }) => item}
				header={
					<>
						<PageHeader
							title={app.data?.display_name || name || t("connectors.title")}
							icon={
								<ConnectorIcon
									name={app.data?.display_name || name || ""}
									logo={app.data?.logo}
									size="lg"
								/>
							}
							titleAdornment={
								ready ? (
									<Badge variant="secondary">
										<Icon as={Check} />
										<Text>{flow === "no_auth" ? t("providers.ready") : t("labels.connected")}</Text>
									</Badge>
								) : undefined
							}
							description={app.data?.description}
						/>
						{app.error ? (
							<ApiErrorPanel error={app.error} onRetry={() => void app.refetch()} />
						) : null}
						<DashboardSection priority="primary">
							<DashboardSectionHeader
								icon={Plug}
								title={t("libraryPort.accounts")}
								count={`${appAccounts.length} connected`}
								description={t("libraryPort.accountsDescription")}
								actions={
									flow !== "no_auth" ? (
										<Button
											variant="outline"
											size="sm"
											disabled={!app.data || app.data.connect_disabled || !flow || action.busy}
											onPress={() => {
												if (name)
													router.push({ pathname: "/connectors/[name]/connect", params: { name } });
											}}
										>
											<Icon as={Plug} />
											<Text>{t("libraryPort.connectAccount")}</Text>
										</Button>
									) : undefined
								}
							/>
							{accounts.error ? (
								<ApiErrorPanel error={accounts.error} onRetry={() => void accounts.refetch()} />
							) : accounts.isPending ? (
								<EntityCardSkeleton />
							) : appAccounts.length ? null : (
								<EmptyState variant="inset" description={t("connectors.noAccounts")} />
							)}
						</DashboardSection>
					</>
				}
				refreshing={app.isRefetching || accounts.isRefetching || tools.isRefetching}
				onRefresh={() => {
					void app.refetch();
					void accounts.refetch();
					void tools.refetch();
				}}
			/>
		</SafeAreaScreen>
	);
}
export function ConnectorConnectPage() {
	return <ConnectorDetailScreen form />;
}

function Account({ connection }: { connection: Connection }) {
	const t = useI18n();
	const confirmationDialog = useConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const cache = useQueryClient();
	const { connectors } = useMobileApi();
	const action = useAuthAction(scope);
	const capture = useForegroundLease();

	const disconnect = () => {
		const visible = capture();
		const perform = () => {
			if (!visible() || !scope.isCurrent()) return;
			return action.runOrThrow(async (isCurrent) => {
				await read((s) => connectors.disconnect(connection.id, s));
				if (isCurrent())
					await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "connectors") });
			});
		};
		confirmationDialog.show(
			connectorDisconnectTitle(connection.alias || connection.account_display || "this account"),
			copy.disconnectDescription,
			[
				{ text: t("account.cancel"), style: "cancel" },
				{ text: copy.disconnect, style: "destructive", onPress: perform },
			],
		);
	};
	return (
		<WebView recipe={connectorDetailClasses.accountRow}>
			<WebView recipe={connectorDetailClasses.identitySkeleton}>
				<WebText recipe={connectorDetailClasses.title}>
					{connection.alias || connection.account_display || connection.id}
				</WebText>
				<WebText recipe={connectorDetailClasses.subtitle}>
					{isActiveConnection(connection) ? t("labels.connected") : connection.status}
				</WebText>
			</WebView>
			<WebView recipe={connectorDetailClasses.hint}>
				<Button
					variant="ghost"
					size="sm"
					onPress={() =>
						router.push({
							pathname: "/connectors/[name]/accounts/[id]/rename",
							params: { name: connection.app_name, id: connection.id },
						})
					}
				>
					<Text>{copy.rename}</Text>
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className={webView(memoryDetailClasses.deleteAction)}
					textClassName={webText(memoryDetailClasses.deleteAction)}
					disabled={action.busy}
					onPress={disconnect}
				>
					<Icon as={Unplug} />
					<Text>{t("connectors.disconnect")}</Text>
				</Button>
			</WebView>
			{action.error ? <ApiErrorPanel error={action.error} /> : null}
			{confirmationDialog.dialog}
		</WebView>
	);
}

function ConnectorAliasField({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (value: string) => void;
	disabled: boolean;
}) {
	return (
		<WebView recipe={accountAliasFieldClasses.field}>
			<Label>{copy.name}</Label>
			<Input
				accessibilityLabel={copy.name}
				placeholder={copy.namePlaceholder}
				value={value}
				onChangeText={onChange}
				editable={!disabled}
				maxLength={256}
				autoCapitalize="none"
				autoCorrect={false}
			/>
			<WebText recipe={accountAliasFieldClasses.hint}>{copy.nameHint}</WebText>
		</WebView>
	);
}

export function ConnectorRenamePage() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ name?: string; id?: string }>();
	const connections = useConnections();
	const connection = connections.data?.find(
		(c) => c.id === routeParam(params.id) && c.app_name === routeParam(params.name),
	);
	return connection && !connections.isError ? (
		<ConnectorRename
			key={`${scope.identity}:${scope.generation}:${connection.id}`}
			connection={connection}
		/>
	) : (
		<SheetPage title={copy.renameTitle} fallback="/connectors">
			{connections.isPending ? (
				<EntityCardSkeleton />
			) : (
				<ApiErrorPanel error={connections.error} onRetry={() => void connections.refetch()} />
			)}
		</SheetPage>
	);
}
function ConnectorRename({ connection }: { connection: Connection }) {
	const t = useI18n();
	const scope = useAccountScope(),
		read = useAccountRead(),
		capture = useForegroundLease();
	const { connectors } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [alias, setAlias] = useState(connection.alias ?? "");
	const [closeError, setCloseError] = useState<unknown>();
	const sheet = useSheet<boolean>({ fallback: "/connectors", busy: action.busy });
	const save = () =>
		action.run(async (current) => {
			const visible = capture();
			if (!visible()) return;
			const fresh = (await read((s) => connectors.list(s))).find(
				(c) => c.id === connection.id && c.app_name === connection.app_name,
			);
			if (!fresh) throw new Error("Connector unavailable");
			if (!current() || !visible()) return;
			await read((s) => connectors.update(connection.id, { alias: alias.trim() }, s));
			if (!current()) return;
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "connectors") });
			if (current() && visible()) await sheet.close(true);
		});
	return (
		<SheetPage
			title={copy.renameTitle}
			description={
				connection.account_display && connection.account_display !== connection.alias
					? connection.account_display
					: t("labels.connectorAccount", { id: connection.id })
			}
			fallback="/connectors"
			busy={action.busy}
			sheet={sheet}
		>
			<ConnectorAliasField value={alias} onChange={setAlias} disabled={action.busy} />
			<Button
				variant="outline"
				disabled={action.busy}
				onPress={() => void sheet.close().catch(setCloseError)}
			>
				<Text>{copy.cancel}</Text>
			</Button>
			<Button
				disabled={action.busy || alias.trim() === (connection.alias ?? "")}
				onPress={() => void save()}
			>
				<Text>{copy.rename}</Text>
			</Button>
			{action.error || closeError ? <ApiErrorPanel error={action.error ?? closeError} /> : null}
		</SheetPage>
	);
}
