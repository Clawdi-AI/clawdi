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
	accountAliasDialogClasses,
	accountAliasFieldClasses,
	connectorDetailClasses,
	connectorsSurfaceClasses,
	credentialsDialogClasses,
	ENTITY_GRID_CLASS,
	memoryDetailClasses,
} from "@clawdi/shared/ui";
import {
	connectorConnectTitle,
	connectorDisconnectTitle,
	connectorFormCopy as copy,
	getProjectResourceDefinition,
} from "@clawdi/shared/view";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import { Check, Plug, Unplug, Wrench } from "lucide-react-native";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useMobileApi } from "@/components/api-provider";
import { ConnectorCard } from "@/components/connectors/connector-card";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { DashboardSection, DashboardSectionHeader } from "@/components/dashboard/section";
import { DetailBackLink, LibraryPage } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { EntityCardSkeleton } from "@/components/entity-card";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { AppText } from "@/components/ui/primitives";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { WebText, WebView, webText, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
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
	return (
		<LibraryPage>
			<PageHeader
				title={t("connectors.title")}
				description={getProjectResourceDefinition("connectors").managementDescription}
				status={
					<WebView recipe={connectorsSurfaceClasses.filters}>
						<Badge variant="secondary">
							<Text>{total} available</Text>
						</Badge>
						<Badge>
							<Text>{connectedNames.length} active</Text>
						</Badge>
					</WebView>
				}
			/>
			<ListToolbar
				search={
					<SearchInput
						value={search}
						onChange={setSearch}
						placeholder={t("libraryPort.searchConnectors")}
					/>
				}
			/>
			{!search && (connectedNames.length || connections.error) ? (
				<WebView recipe={connectorsSurfaceClasses.section}>
					<SectionLabel count={`${connectedNames.length} apps`}>
						{t("libraryPort.yourConnections")}
					</SectionLabel>
					{connections.error ? (
						<ApiErrorPanel error={connections.error} onRetry={() => void connections.refetch()} />
					) : (
						<WebView recipe={ENTITY_GRID_CLASS}>
							{connectedNames.map((name, i) => {
								const app = metadata[i]?.data ?? apps.find((app) => app.name === name);
								return app ? (
									<ConnectorCard key={name} app={app} isConnected />
								) : metadata[i]?.error ? (
									<ApiErrorPanel
										key={name}
										error={metadata[i]?.error}
										onRetry={() => void metadata[i]?.refetch()}
									/>
								) : (
									<EntityCardSkeleton key={name} />
								);
							})}
						</WebView>
					)}
				</WebView>
			) : null}
			<WebView recipe={connectorsSurfaceClasses.section}>
				<SectionLabel count={`${total} available`}>{t("libraryPort.allConnectors")}</SectionLabel>
				{catalog.error ? (
					<ApiErrorPanel error={catalog.error} onRetry={() => void catalog.refetch()} />
				) : (
					<WebView recipe={ENTITY_GRID_CLASS}>
						{catalog.isPending
							? [0, 1, 2, 3].map((i) => <EntityCardSkeleton key={i} />)
							: apps.map((app) => (
									<ConnectorCard
										key={app.name}
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
								))}
					</WebView>
				)}
			</WebView>
			{!catalog.isPending && !catalog.error && !apps.length ? (
				<EmptyState title={t("libraryPort.noConnectors")} />
			) : null}
			{catalog.hasNextPage ? (
				<Button
					variant="outline"
					disabled={catalog.isFetching}
					onPress={() => void catalog.fetchNextPage()}
				>
					<Text>{t("inventory.loadMore")}</Text>
				</Button>
			) : null}
		</LibraryPage>
	);
}

export function ConnectorDetailScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ name?: string | string[] }>();
	const name = routeParam(params.name);
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
	const [authOpen, setAuthOpen] = useState(false);
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
	return (
		<LibraryPage>
			<DetailBackLink href="/connectors" label={t("connectors.title")} />
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
							<Text>{flow === "no_auth" ? "Ready" : "Connected"}</Text>
						</Badge>
					) : undefined
				}
				description={app.data?.description}
			/>
			{app.error ? <ApiErrorPanel error={app.error} onRetry={() => void app.refetch()} /> : null}
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
								onPress={() => setAuthOpen(true)}
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
				) : appAccounts.length ? (
					appAccounts.map((c) => <Account key={c.id} connection={c} />)
				) : (
					<EmptyState variant="inset" description={t("connectors.noAccounts")} />
				)}
			</DashboardSection>
			<DashboardSection>
				<DashboardSectionHeader
					icon={Wrench}
					title={t("libraryPort.tools")}
					count={`${tools.data?.length ?? 0} tools`}
					description={t("libraryPort.toolsDescription")}
					actions={
						(tools.data?.length ?? 0) > 8 ? (
							<SearchInput value={toolSearch} onChange={setToolSearch} />
						) : undefined
					}
				/>
				{tools.error ? (
					<ApiErrorPanel error={tools.error} onRetry={() => void tools.refetch()} />
				) : tools.isPending ? (
					<EntityCardSkeleton />
				) : (
					<WebView recipe={connectorDetailClasses.toolList}>
						{filteredTools.map((tool, index) => (
							<WebView
								key={tool.name}
								recipe={`${connectorDetailClasses.toolRow} ${index ? "border-t" : ""}`}
							>
								<WebView recipe={connectorDetailClasses.toolBody}>
									<WebView recipe={connectorDetailClasses.toolHeading}>
										<WebText recipe={connectorDetailClasses.title}>
											{tool.display_name || tool.name}
										</WebText>
									</WebView>
									<WebText recipe={connectorDetailClasses.toolDescription}>
										{tool.description}
									</WebText>
								</WebView>
							</WebView>
						))}
					</WebView>
				)}
			</DashboardSection>
			<Dialog
				open={authOpen}
				onOpenChange={(v) => {
					if (!action.busy) {
						setAuthOpen(v);
						if (!v) setValues({});
					}
				}}
			>
				<DialogContent className={webView(credentialsDialogClasses.dialog)}>
					<DialogHeader>
						<DialogTitle>{connectorConnectTitle(app.data?.display_name ?? name ?? "")}</DialogTitle>
						{flow === "credentials" ? (
							<DialogDescription>{copy.credentialsDescription}</DialogDescription>
						) : null}
					</DialogHeader>
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
										<WebText recipe={credentialsDialogClasses.empty}>
											{copy.credentialsEmpty}
										</WebText>
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
					<DialogFooter>
						<Button variant="outline" disabled={action.busy} onPress={() => setAuthOpen(false)}>
							<Text>{copy.cancel}</Text>
						</Button>
						<Button variant="default" disabled={action.busy || !canConnect} onPress={connect}>
							<Text>{copy.connect}</Text>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</LibraryPage>
	);
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
	const [alias, setAlias] = useState(connection.alias ?? "");
	const [editing, setEditing] = useState(false);
	const update = (disconnect: boolean) => {
		const visible = capture();
		const perform = () => {
			if (!visible() || !scope.isCurrent()) return;
			return action.run(async (isCurrent) => {
				if (disconnect) await read((s) => connectors.disconnect(connection.id, s));
				else await read((s) => connectors.update(connection.id, { alias: alias.trim() }, s));
				if (isCurrent()) {
					setEditing(false);
				}
				if (isCurrent())
					await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "connectors") });
			});
		};
		if (!disconnect) perform();
		else
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
					{isActiveConnection(connection) ? "Connected" : connection.status}
				</WebText>
			</WebView>
			<WebView recipe={connectorDetailClasses.hint}>
				<Button variant="ghost" size="sm" onPress={() => setEditing(true)}>
					<Text>Rename</Text>
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className={webView(memoryDetailClasses.deleteAction)}
					textClassName={webText(memoryDetailClasses.deleteAction)}
					disabled={action.busy}
					onPress={() => update(true)}
				>
					<Icon as={Unplug} />
					<Text>{t("connectors.disconnect")}</Text>
				</Button>
			</WebView>
			{action.error ? <ApiErrorPanel error={action.error} /> : null}
			<Dialog
				open={editing}
				onOpenChange={(next) => {
					if (!action.busy) setEditing(next);
				}}
			>
				<DialogContent
					className={webView(accountAliasDialogClasses.dialog)}
					showCloseButton={!action.busy}
				>
					<DialogHeader>
						<DialogTitle>{copy.renameTitle}</DialogTitle>
						<DialogDescription>
							{connection.account_display && connection.account_display !== connection.alias
								? connection.account_display
								: `Account ${connection.id}`}
						</DialogDescription>
					</DialogHeader>
					<ConnectorAliasField value={alias} onChange={setAlias} disabled={action.busy} />
					<DialogFooter>
						<Button variant="outline" disabled={action.busy} onPress={() => setEditing(false)}>
							<Text>{copy.cancel}</Text>
						</Button>
						<Button
							disabled={action.busy || alias.trim() === (connection.alias ?? "")}
							onPress={() => update(false)}
						>
							<Text>{copy.rename}</Text>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
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
