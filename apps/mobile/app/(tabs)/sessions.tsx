import {
	normalizeSessionListQuery,
	SESSION_SORT_KEYS,
	type SessionListQuery,
} from "@clawdi/shared/api";
import { isSearchQueryReady, SEARCH_QUERY_MAX_LENGTH } from "@clawdi/shared/consts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
	type CloudSession,
	SessionRow,
	useCloudAgents,
	useCloudSessions,
} from "../../src/features/cloud-inventory";
import { InventoryList } from "../../src/features/inventory-list";
import { routeParam, uniqueSessions } from "../../src/features/read-helpers";
import { useI18n } from "../../src/i18n";
import { useAccountScope } from "../../src/platform/account-lifecycle";
import { ErrorState } from "../../src/ui/feedback";
import { NativeButton, NativePicker } from "../../src/ui/native-controls";
import { AppText, AppTextInput, AppView } from "../../src/ui/primitives";

export default function SessionsRoute() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ agentId?: string | string[] }>();
	const agentId = typeof params.agentId === "string" ? routeParam(params.agentId) : undefined;
	return (
		<SessionsView
			key={`${scope.identity}:${scope.generation}:${agentId ?? "all"}`}
			agentId={agentId}
			invalid={params.agentId !== undefined && !agentId}
		/>
	);
}

function SessionsView({ agentId, invalid }: { agentId?: string; invalid: boolean }) {
	const t = useI18n();
	const router = useRouter();
	const [draft, setDraft] = useState(() => normalizeSessionListQuery());
	const [applied, setApplied] = useState(() => normalizeSessionListQuery());
	const [expanded, setExpanded] = useState(false);
	const sessions = useCloudSessions(agentId, !invalid, applied);
	const agents = useCloudAgents();
	const agentTypes = [
		...new Set([
			...(agents.data ?? []).map((agent) => agent.agent_type),
			...(draft.agent ? [draft.agent] : []),
		]),
	].sort();
	const searchValid = !draft.q?.trim() || isSearchQueryReady(draft.q);
	const update = (values: SessionListQuery) => setDraft((current) => ({ ...current, ...values }));
	const reset = () => {
		setDraft(normalizeSessionListQuery());
		setApplied(normalizeSessionListQuery());
	};
	if (invalid)
		return (
			<InventoryList<CloudSession>
				items={[]}
				title={t("sessions.title")}
				description={t("sessions.filterInvalid")}
				empty={t("sessions.empty")}
				renderItem={(item) => <SessionRow session={item} />}
				refreshing={false}
				onRefresh={() => {}}
				error={false}
				onRetry={() => {}}
				header={
					<NativeButton
						label={t("sessions.clearFilter")}
						onPress={() => router.replace("/sessions")}
					/>
				}
			/>
		);
	return (
		<InventoryList
			items={uniqueSessions(sessions.data?.pages ?? [])}
			title={t("sessions.title")}
			description={t(agentId ? "sessions.filter" : "sessions.description")}
			empty={t(sessions.isPending ? "loading.sessions" : "sessionFilters.empty")}
			header={
				<AppView className="gap-3">
					<AppTextInput
						accessibilityLabel={t("sessionFilters.search")}
						placeholder={t("sessionFilters.search")}
						value={draft.q ?? ""}
						maxLength={SEARCH_QUERY_MAX_LENGTH}
						autoCapitalize="none"
						autoCorrect={false}
						className="rounded-xl bg-card p-3 text-foreground"
						onChangeText={(q) =>
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
					{!searchValid ? (
						<AppText accessibilityRole="alert">{t("sessionFilters.searchInvalid")}</AppText>
					) : null}
					<NativeButton
						label={t("sessionFilters.options")}
						onPress={() => setExpanded(!expanded)}
					/>
					{expanded ? (
						<>
							<AppText>{t("sessionFilters.agent")}</AppText>
							<NativePicker
								value={draft.agent ?? ""}
								disabled={agents.isFetching}
								options={[
									{ value: "", label: t("sessionFilters.all") },
									...agentTypes.map((value) => ({ value, label: value })),
								]}
								onValueChange={(agent) => update({ agent })}
							/>
							{agents.isError ? <ErrorState onRetry={() => void agents.refetch()} /> : null}
							<AppText>{t("sessionFilters.type")}</AppText>
							<NativePicker
								value={draft.automated === undefined ? "all" : String(draft.automated)}
								options={[
									{ value: "all", label: t("sessionFilters.all") },
									{ value: "false", label: t("sessionFilters.manual") },
									{ value: "true", label: t("sessionFilters.automated") },
								]}
								onValueChange={(value) =>
									update({ automated: value === "all" ? undefined : value === "true" })
								}
							/>
							<AppText>{t("sessionFilters.pr")}</AppText>
							<NativePicker
								value={draft.has_pr === undefined ? "all" : String(draft.has_pr)}
								options={[
									{ value: "all", label: t("sessionFilters.all") },
									{ value: "true", label: t("sessionFilters.hasPr") },
									{ value: "false", label: t("sessionFilters.noPr") },
								]}
								onValueChange={(value) =>
									update({ has_pr: value === "all" ? undefined : value === "true" })
								}
							/>
							<AppText>{t("sessionFilters.sort")}</AppText>
							<NativePicker
								value={draft.sort ?? "last_activity_at"}
								options={SESSION_SORT_KEYS.filter(
									(key) => key !== "relevance" || (!!draft.q && isSearchQueryReady(draft.q)),
								).map((value) => ({ value, label: t(`sessionFilters.${value}`) }))}
								onValueChange={(sort) => update({ sort })}
							/>
							<AppText>{t("sessionFilters.order")}</AppText>
							<NativePicker
								value={draft.order ?? "desc"}
								options={[
									{ value: "desc", label: t("sessionFilters.desc") },
									{ value: "asc", label: t("sessionFilters.asc") },
								]}
								onValueChange={(order) => update({ order })}
							/>
							<AppText>{t("sessionFilters.pageSize")}</AppText>
							<NativePicker
								value={draft.page_size ?? 25}
								options={[25, 50, 100].map((value) => ({ value, label: String(value) }))}
								onValueChange={(page_size) => update({ page_size })}
							/>
						</>
					) : null}
					<NativeButton
						label={t("sessionFilters.apply")}
						disabled={!searchValid}
						onPress={() => setApplied(normalizeSessionListQuery(draft))}
					/>
					<NativeButton label={t("sessionFilters.reset")} onPress={reset} />
					<AppText accessibilityLiveRegion="polite">
						{sessions.isFetching
							? t("loading.sessions")
							: `${t("sessionFilters.total")}: ${sessions.data?.pages[0]?.total ?? 0}`}
					</AppText>
					<NativeButton
						label={t("sessionShares.title")}
						onPress={() => router.push("/sessions/shared")}
					/>
					{agentId ? (
						<NativeButton
							label={t("sessions.clearFilter")}
							onPress={() => router.replace("/sessions")}
						/>
					) : null}
				</AppView>
			}
			renderItem={(session) => (
				<SessionRow session={session} searchQuery={applied.q ?? undefined} />
			)}
			refreshing={sessions.isRefetching && !sessions.isFetchingNextPage}
			onRefresh={() => {
				if (!sessions.isFetching) void sessions.refetch();
			}}
			error={sessions.isError}
			busy={sessions.isFetching}
			onRetry={() =>
				void (sessions.isFetchNextPageError ? sessions.fetchNextPage() : sessions.refetch())
			}
			more={sessions.hasNextPage}
			onMore={() => {
				if (!sessions.isFetching) void sessions.fetchNextPage();
			}}
		/>
	);
}
