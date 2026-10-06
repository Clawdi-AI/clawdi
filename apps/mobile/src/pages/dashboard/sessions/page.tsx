import {
	normalizeSessionListQuery,
	SESSION_SORT_KEYS,
	type SessionListQuery,
} from "@clawdi/shared/api";
import { isSearchQueryReady, SEARCH_QUERY_MAX_LENGTH } from "@clawdi/shared/consts";
import {
	dataTableFacetedFilterClasses as filterStyles,
	dataTablePaginationClasses as paginationStyles,
	sessionsPageClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentTypeLabel,
	SESSION_LIST_COPY as copy,
	getProjectResourceDefinition,
	sessionListEmptyMessage,
} from "@clawdi/shared/view";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronLeft, ChevronRight, Link2, PlusCircle } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { TabPage } from "@/components/dashboard/tab-page";
import { FilterChip } from "@/components/filter-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { SessionFeed } from "@/components/sessions/session-feed";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchInput } from "@/components/ui/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Text } from "@/components/ui/text";
import { WebIcon, WebText, WebView, webView } from "@/components/ui/web-layout";
import { useCloudAgents, useCloudSessions } from "@/hooks/cloud-inventory";
import { useI18n } from "@/lib/i18n";
import { routeParam, uniqueSessions } from "@/lib/route-params";
import { useAccountScope } from "@/platform/account-lifecycle";
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
		[applied, setApplied] = useState(() => normalizeSessionListQuery()),
		[page, setPage] = useState(1);
	const sessions = useCloudSessions(agentId, !invalid, applied),
		agents = useCloudAgents();
	const searchValid = !draft.q?.trim() || isSearchQueryReady(draft.q);
	useEffect(() => {
		if (!searchValid) return;
		const timeout = setTimeout(() => {
			requestRevision.current++;
			setPaginationError(undefined);
			setApplied(normalizeSessionListQuery(draft));
			setPage(1);
		}, 250);
		return () => clearTimeout(timeout);
	}, [draft, searchValid]);
	const update = (values: SessionListQuery) => setDraft((current) => ({ ...current, ...values }));
	const reset = () => {
		requestRevision.current++;
		setPaginationError(undefined);
		setDraft(normalizeSessionListQuery());
		setApplied(normalizeSessionListQuery());
		setPage(1);
	};
	const agentTypes = [
		...new Set([
			...(agents.data ?? []).map((agent) => agent.agent_type),
			...(draft.agent ? [draft.agent] : []),
		]),
	].sort();
	const filtered = Boolean(
		draft.q?.trim() || draft.agent || draft.has_pr != null || draft.automated != null,
	);
	const total = sessions.data?.pages[0]?.total ?? 0,
		pageSize = applied.page_size ?? 25,
		pageCount = Math.max(1, Math.ceil(total / pageSize));
	const rows = uniqueSessions(sessions.data?.pages ?? []).slice(
		(page - 1) * pageSize,
		page * pageSize,
	);
	const next = async () => {
		if (sessions.isFetching || !scope.isCurrent()) return;
		const revision = requestRevision.current;
		try {
			if (page >= (sessions.data?.pages.length ?? 0)) {
				const result = await sessions.fetchNextPage();
				if (result.isError) return;
			}
			if (!scope.isCurrent() || revision !== requestRevision.current) return;
			setPaginationError(undefined);
			setPage((current) => current + 1);
		} catch (error) {
			if (scope.isCurrent() && revision === requestRevision.current) setPaginationError(error);
		}
	};
	useEffect(() => {
		if (sessions.data && !sessions.isFetching) setPage((current) => Math.min(current, pageCount));
	}, [sessions.data, sessions.isFetching, pageCount]);

	const tri = (value: string) => (value === "all" ? undefined : value === "true");
	return (
		<TabPage
			title={copy.title}
			refreshing={sessions.isRefetching && !sessions.isFetchingNextPage}
			onRefresh={() => {
				if (!sessions.isFetching) void sessions.refetch();
			}}
		>
			<PageHeader
				title={copy.title}
				description={
					invalid
						? t("sessions.filterInvalid")
						: getProjectResourceDefinition("sessions").managementDescription
				}
				actions={
					<Button variant="outline" size="sm" onPress={() => router.push("/sessions/shared")}>
						<WebIcon as={Link2} recipe={filterStyles.triggerIcon} />
						<Text>{copy.sharedLinks}</Text>
					</Button>
				}
			/>
			{invalid ? (
				<Button variant="outline" onPress={() => router.replace("/sessions")}>
					<Text>{t("sessions.clearFilter")}</Text>
				</Button>
			) : (
				<WebView recipe={styles.content}>
					<ListToolbar
						search={
							<SearchInput
								value={draft.q ?? ""}
								placeholder={copy.searchPlaceholder}
								maxLength={SEARCH_QUERY_MAX_LENGTH}
								onChange={(q) =>
									update({
										q,
										sort:
											isSearchQueryReady(q) && draft.sort === "last_activity_at"
												? "relevance"
												: !isSearchQueryReady(q) && draft.sort === "relevance"
													? "last_activity_at"
													: draft.sort,
									})
								}
							/>
						}
						filters={
							<>
								{agentTypes.length > 0 ? (
									<SessionFilter
										title={copy.agent}
										value={draft.agent ?? "all"}
										options={agentTypes.map((value) => ({ value, label: agentTypeLabel(value) }))}
										onChange={(agent) => update({ agent: agent === "all" ? undefined : agent })}
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
					{!sessions.isError || sessions.data ? (
						<SessionFeed
							sessions={rows}
							isLoading={sessions.isPending}
							grouped={applied.sort === "last_activity_at" || applied.sort === "started_at"}
							groupBy={applied.sort === "started_at" ? "started_at" : "last_activity_at"}
							quietAutomated={!applied.q}
							searchQuery={applied.q ?? ""}
							emptyMessage={sessionListEmptyMessage(applied.q ?? "", filtered)}
						/>
					) : null}
					<WebView recipe={paginationStyles.root}>
						<WebText recipe={paginationStyles.results}>
							{total === 0
								? "0 results"
								: `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}`}
						</WebText>
						<WebView recipe={paginationStyles.controls}>
							<WebView recipe={paginationStyles.pageSize} className="flex-row">
								<WebText recipe={paginationStyles.results}>{copy.rows}</WebText>
								<Select
									value={String(draft.page_size ?? 25)}
									onValueChange={(value) => update({ page_size: Number(value) })}
								>
									<SelectTrigger size="sm" className={webView(paginationStyles.pageSizeTrigger)}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{[25, 50, 100].map((value) => (
											<SelectItem key={value} value={String(value)}>
												{value}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</WebView>
							<WebView recipe={paginationStyles.navigation} className="flex-row">
								<Button
									variant="outline"
									size="icon-sm"
									accessibilityLabel="Previous page"
									disabled={page <= 1 || sessions.isFetching}
									onPress={() => setPage((current) => current - 1)}
								>
									<WebIcon as={ChevronLeft} recipe={paginationStyles.actionIcon} />
								</Button>
								<WebText recipe={paginationStyles.pageCount}>
									{page} / {pageCount}
								</WebText>
								<Button
									variant="outline"
									size="icon-sm"
									accessibilityLabel="Next page"
									disabled={page >= pageCount || sessions.isFetching}
									onPress={() => void next()}
								>
									<WebIcon as={ChevronRight} recipe={paginationStyles.actionIcon} />
								</Button>
							</WebView>
						</WebView>
					</WebView>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button variant="ghost" size="sm">
									<Text>{t("sessionFilters.options")}</Text>
								</Button>
							}
						/>
						<DropdownMenuContent>
							<DropdownMenuItem label={t("sessionFilters.sort")} />
							{SESSION_SORT_KEYS.filter(
								(key) => key !== "relevance" || (!!draft.q && isSearchQueryReady(draft.q)),
							).map((sort) => (
								<DropdownMenuItem
									key={sort}
									label={t(`sessionFilters.${sort}`)}
									onSelect={() => update({ sort })}
								/>
							))}
							<DropdownMenuItem
								label={t("sessionFilters.asc")}
								onSelect={() => update({ order: "asc" })}
							/>
							<DropdownMenuItem
								label={t("sessionFilters.desc")}
								onSelect={() => update({ order: "desc" })}
							/>
						</DropdownMenuContent>
					</DropdownMenu>
				</WebView>
			)}
		</TabPage>
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
