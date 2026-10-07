import { normalizeSessionListQuery, type SessionListQuery } from "@clawdi/shared/api";
import { isSearchQueryReady, SEARCH_QUERY_MAX_LENGTH } from "@clawdi/shared/consts";
import {
	dataTableFacetedFilterClasses as filterStyles,
	dataTablePaginationClasses as paginationStyles,
	sessionsPageClasses as styles,
} from "@clawdi/shared/ui";
import {
	AGENT_PROFILES_COPY,
	agentDisplayName,
	agentProfileFilterLabel,
	agentTypeLabel,
	SESSION_LIST_COPY as copy,
	getProjectResourceDefinition,
	groupSessionsByRecency,
	sessionListEmptyMessage,
} from "@clawdi/shared/view";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { PlusCircle, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	useAgentProfiles,
	useAgentSessionProfileFilter,
} from "@/components/dashboard/agent-profiles";
import { FilterChip } from "@/components/filter-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import { SessionCard, SessionFeed } from "@/components/sessions/session-feed";
import { sessionsHeaderMenu } from "@/components/sessions/sessions-header-menu";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { Text } from "@/components/ui/text";
import { WebIcon, WebText, WebView, webView } from "@/components/ui/web-layout";
import { useCloudAgent, useCloudAgents, useCloudSessions } from "@/hooks/cloud-inventory";
import { useI18n } from "@/lib/i18n";
import { routeParam, uniqueSessions } from "@/lib/route-params";
import { useAccountScope } from "@/platform/account-lifecycle";
import { NativeHeader, useHeaderSearch } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
export default function SessionsRoute() {
	const scope = useAccountScope(),
		params = useLocalSearchParams<{ id?: string | string[]; agentId?: string | string[] }>();
	const agentId =
		typeof (params.id ?? params.agentId) === "string"
			? routeParam(params.id ?? params.agentId)
			: undefined;
	return (
		<SessionsView
			key={`${scope.identity}:${scope.generation}:${agentId ?? "all"}`}
			agentId={agentId}
			invalid={params.agentId !== undefined && !agentId}
		/>
	);
}
function SessionsView({ agentId, invalid }: { agentId?: string; invalid: boolean }) {
	const scope = useAccountScope();
	const requestRevision = useRef(0);
	const [paginationError, setPaginationError] = useState<unknown>();
	const t = useI18n(),
		router = useRouter();
	const [draft, setDraft] = useState(() => normalizeSessionListQuery()),
		[applied, setApplied] = useState(() => normalizeSessionListQuery());
	// Like Web, profiles load once the Agent does, so the default profile is never unnamed.
	const agent = useCloudAgent(agentId),
		agentName = agent.data ? agentDisplayName(agent.data) : undefined,
		profiles = useAgentProfiles(agentId, { enabled: !invalid && Boolean(agentName) });
	const profileFilter = useAgentSessionProfileFilter({
		agentName,
		profiles: profiles.data,
		profilesLoading: agent.isLoading || profiles.isLoading,
	});
	const profileChipLabel =
		profileFilter.selected && agentName
			? agentProfileFilterLabel(agentName, profileFilter.selected)
			: null;
	const profileKey = profileFilter.profileKey;
	const sessions = useCloudSessions(agentId, !invalid && !profileFilter.pending, {
			...applied,
			profile_key: profileKey,
		}),
		agents = useCloudAgents();
	useEffect(() => {
		requestRevision.current++;
		setPaginationError(undefined);
	}, [profileKey]);
	const searchValid = !draft.q?.trim() || isSearchQueryReady(draft.q);
	useEffect(() => {
		if (!searchValid) return;
		const timeout = setTimeout(() => {
			requestRevision.current++;
			setPaginationError(undefined);
			setApplied(normalizeSessionListQuery(draft));
		}, 250);
		return () => clearTimeout(timeout);
	}, [draft, searchValid]);
	const update = (values: SessionListQuery) => setDraft((current) => ({ ...current, ...values }));
	const reset = () => {
		requestRevision.current++;
		setPaginationError(undefined);
		setDraft(normalizeSessionListQuery());
		setApplied(normalizeSessionListQuery());
		if (profileKey !== undefined) profileFilter.clear();
	};
	const agentTypes = [
		...new Set([
			...(agents.data ?? []).map((agent) => agent.agent_type),
			...(draft.agent ? [draft.agent] : []),
		]),
	].sort();
	const listFiltered = Boolean(
		draft.q?.trim() || draft.agent || draft.has_pr != null || draft.automated != null,
	);
	const filtered = listFiltered || profileKey !== undefined;
	const total = sessions.data?.pages[0]?.total ?? 0;
	const rows = uniqueSessions(sessions.data?.pages ?? []);
	const grouped = applied.sort === "last_activity_at" || applied.sort === "started_at";
	const listRows = grouped
		? groupSessionsByRecency(
				rows,
				applied.sort === "started_at" ? "started_at" : "last_activity_at",
			).flatMap((group) =>
				group.items.map((session, index) => ({
					session,
					label: index === 0 ? group.label : undefined,
				})),
			)
		: rows.map((session) => ({ session, label: undefined }));
	const next = async () => {
		if (sessions.isFetching || !scope.isCurrent() || !sessions.hasNextPage) return;
		const revision = requestRevision.current;
		try {
			const result = await sessions.fetchNextPage();
			if (!scope.isCurrent() || revision !== requestRevision.current) return;
			setPaginationError(result.isError ? result.error : undefined);
		} catch (error) {
			if (scope.isCurrent() && revision === requestRevision.current) setPaginationError(error);
		}
	};
	const search = useHeaderSearch({
		value: draft.q ?? "",
		placeholder: copy.searchPlaceholder,
		maxLength: SEARCH_QUERY_MAX_LENGTH,
		onChange: (q) =>
			update({
				q,
				sort:
					isSearchQueryReady(q) && draft.sort === "last_activity_at"
						? "relevance"
						: !isSearchQueryReady(q) && draft.sort === "relevance"
							? "last_activity_at"
							: draft.sort,
			}),
	});

	const tri = (value: string) => (value === "all" ? undefined : value === "true");
	return (
		<SafeAreaScreen>
			<Stack.Screen options={{ headerSearchBarOptions: invalid ? undefined : search }} />
			<NativeHeader
				title={copy.title}
				actions={[
					{ id: "shared", label: copy.sharedLinks, onPress: () => router.push("/sessions/shared") },
				]}
				menu={sessionsHeaderMenu({
					t,
					sort: draft.sort,
					order: draft.order,
					searchReady: !!draft.q && isSearchQueryReady(draft.q),
					profileSection: profileFilter.section,
					onChange: update,
				})}
			/>
			<NativeList
				data={invalid ? [] : listRows}
				keyExtractor={(row) => row.session.id}
				renderItem={({ item }) => (
					<WebView recipe="gap-2">
						{item.label ? <SectionLabel>{item.label}</SectionLabel> : null}
						<SessionCard
							session={item.session}
							showAgent={!agentId}
							quietAutomated={!applied.q}
							searchQuery={applied.q ?? ""}
						/>
					</WebView>
				)}
				refreshing={sessions.isRefetching && !sessions.isFetchingNextPage}
				onRefresh={() => {
					if (!sessions.isFetching) void sessions.refetch();
				}}
				hasMore={!invalid && sessions.hasNextPage && !sessions.isError && !paginationError}
				loadingMore={sessions.isFetching}
				onLoadMore={() => void next()}
				header={
					<WebView recipe="gap-5 pb-3">
						<PageHeader
							title={copy.title}
							description={
								invalid
									? t("sessions.filterInvalid")
									: getProjectResourceDefinition("sessions").managementDescription
							}
						/>
						{invalid ? (
							<Button variant="outline" onPress={() => router.replace("/sessions")}>
								<Text>{t("sessions.clearFilter")}</Text>
							</Button>
						) : (
							<WebView recipe={styles.content}>
								<ListToolbar
									filters={
										<>
											{profileChipLabel ? (
												<FilterChip active onClick={profileFilter.clear}>
													<Text>{`${AGENT_PROFILES_COPY.filterTitle} · ${profileChipLabel}`}</Text>
													<Icon as={X} />
												</FilterChip>
											) : null}
											{agentTypes.length > 0 ? (
												<SessionFilter
													title={copy.agent}
													value={draft.agent ?? "all"}
													options={agentTypes.map((value) => ({
														value,
														label: agentTypeLabel(value),
													}))}
													onChange={(agent) =>
														update({ agent: agent === "all" ? undefined : agent })
													}
												/>
											) : null}
											<SessionFilter
												title={copy.type}
												value={draft.automated == null ? "all" : String(draft.automated)}
												options={[
													{ value: "false", label: copy.manual },
													{ value: "true", label: copy.automated },
												]}
												onChange={(value) => update({ automated: tri(value) })}
											/>
											<SessionFilter
												title={copy.prLinks}
												value={draft.has_pr == null ? "all" : String(draft.has_pr)}
												options={[
													{ value: "true", label: copy.hasPr },
													{ value: "false", label: copy.noPr },
												]}
												onChange={(value) => update({ has_pr: tri(value) })}
											/>
										</>
									}
									actions={
										filtered ? (
											<Button
												size="sm"
												variant="ghost"
												className={webView(styles.clearFilters)}
												onPress={reset}
											>
												<Text>{copy.reset}</Text>
											</Button>
										) : undefined
									}
								/>
								{!searchValid ? (
									<WebText recipe={styles.updateStatus} accessibilityRole="alert">
										{t("sessionFilters.searchInvalid")}
									</WebText>
								) : null}
								{agentId ? (
									<FilterChip active onClick={() => router.replace("/sessions")}>
										{t("sessions.clearFilter")}
									</FilterChip>
								) : null}
								{agents.isError ? (
									<ApiErrorPanel
										error={agents.error}
										onRetry={() => void agents.refetch()}
										title={t("sessionFilters.agent")}
									/>
								) : null}
								{sessions.isError || paginationError ? (
									<ApiErrorPanel
										error={paginationError ?? sessions.error}
										title={copy.error}
										onRetry={() =>
											void (paginationError
												? next()
												: sessions.isFetchNextPageError
													? sessions.fetchNextPage()
													: sessions.refetch())
										}
									/>
								) : null}
							</WebView>
						)}
					</WebView>
				}
				empty={
					!invalid && (!sessions.isError || sessions.data) ? (
						<SessionFeed
							sessions={[]}
							isLoading={sessions.isPending}
							emptyMessage={
								profileKey !== undefined && !listFiltered
									? AGENT_PROFILES_COPY.profileSessionsEmpty
									: sessionListEmptyMessage(applied.q ?? "", filtered)
							}
						/>
					) : null
				}
				footer={
					!invalid ? (
						<WebView recipe="gap-3 pt-2">
							{sessions.isFetchingNextPage ? (
								<SessionFeed sessions={[]} isLoading emptyMessage="" />
							) : null}
							<WebText recipe={paginationStyles.results}>
								{total === 0 ? "0 results" : `${rows.length} of ${total}`}
							</WebText>
						</WebView>
					) : null
				}
			/>
		</SafeAreaScreen>
	);
}
function SessionFilter({
	title,
	value,
	options,
	onChange,
}: {
	title: string;
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
}) {
	const t = useI18n();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="outline"
						size="sm"
						accessibilityState={{ selected: value !== "all" }}
						className={webView(filterStyles.trigger)}
					>
						<WebIcon as={PlusCircle} recipe={filterStyles.triggerIcon} />
						<Text>
							{title}
							{value !== "all" ? " · 1" : ""}
						</Text>
					</Button>
				}
			/>
			<DropdownMenuContent>
				<DropdownMenuItem label={t("sessionFilters.all")} onSelect={() => onChange("all")} />
				{options.map((option) => (
					<DropdownMenuItem
						key={option.value}
						label={option.label}
						onSelect={() => onChange(option.value)}
					/>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
