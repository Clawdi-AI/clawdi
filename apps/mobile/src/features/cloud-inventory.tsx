import {
	ApiClientError,
	type components,
	normalizeSessionListQuery,
	type SessionListQuery,
	sessionDetailLink,
} from "@clawdi/shared/api";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { AppPressable, AppText, AppView } from "../ui/primitives";
import { nextSessionPage } from "./read-helpers";

export type CloudAgent = components["schemas"]["AgentResponse"];
export type CloudSession = components["schemas"]["SessionListItemResponse"];

export function useCloudAgents(projectId?: string) {
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useQuery({
		queryKey: accountQueryKey(scope, "cloud-agents", projectId ?? "all"),
		queryFn: ({ signal }) =>
			read(
				(readSignal) =>
					cloud.listAgents(projectId ? { project_id: projectId } : undefined, readSignal),
				signal,
			),
		enabled: scope.isReady,
		retry: false,
	});
}

export function useCloudAgent(agentId: string | undefined) {
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useQuery({
		queryKey: accountQueryKey(scope, "cloud-agent", agentId ?? "missing"),
		queryFn: ({ signal }) => {
			if (!agentId) throw new Error("An Agent id is required");
			return read((readSignal) => cloud.getAgent(agentId, readSignal), signal);
		},
		enabled: scope.isReady && Boolean(agentId),
		retry: false,
	});
}

export function useCloudSessions(agentId?: string, enabled = true, filters?: SessionListQuery) {
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const query = normalizeSessionListQuery({ ...filters, environment_id: agentId, page: 1 });
	return useInfiniteQuery({
		queryKey: accountQueryKey(scope, "cloud-sessions", query),
		initialPageParam: 1,
		queryFn: ({ signal, pageParam }) =>
			read((readSignal) => cloud.listSessions({ ...query, page: pageParam }, readSignal), signal),
		getNextPageParam: nextSessionPage,
		enabled: scope.isReady && enabled,
		retry: false,
	});
}

export function isNotFound(error: unknown) {
	return error instanceof ApiClientError && error.status === 404;
}

export function useCloudSession(sessionId: string | undefined) {
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useQuery({
		queryKey: accountQueryKey(scope, "cloud-session", sessionId ?? "missing"),
		queryFn: ({ signal }) => {
			if (!sessionId) throw new Error("A Session id is required");
			return read((readSignal) => cloud.getSession(sessionId, readSignal), signal);
		},
		enabled: scope.isReady && Boolean(sessionId),
		retry: false,
	});
}

export function agentDisplayName(
	agent: Pick<CloudAgent, "display_name" | "name" | "default_name" | "machine_name">,
) {
	return (
		agent.display_name?.trim() ||
		agent.name.trim() ||
		agent.default_name?.trim() ||
		agent.machine_name
	);
}

export function sessionDisplayName(
	session: Pick<CloudSession, "summary" | "project_path" | "local_session_id">,
) {
	return session.summary?.trim() || session.project_path?.trim() || session.local_session_id;
}

export function formatDate(value: string | null | undefined): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
		date,
	);
}

export function AgentRow({ agent }: { agent: CloudAgent }) {
	const router = useRouter();
	const t = useI18n();
	return (
		<AppPressable
			accessibilityRole="button"
			className="gap-2 rounded-2xl bg-surface px-4 py-4"
			onPress={() => router.push(`/agents/${encodeURIComponent(agent.id)}`)}
		>
			<AppView className="flex-row items-center justify-between gap-3">
				<AppText numberOfLines={2} className="flex-1 text-base font-semibold text-foreground">
					{agentDisplayName(agent)}
				</AppText>
				<AppText className="text-sm font-semibold text-primary">
					{t("inventory.viewDetails")}
				</AppText>
			</AppView>
			<AppText className="text-sm text-muted">
				{agent.agent_type} · {agent.machine_name}
			</AppText>
			<AppText className="text-sm text-muted">
				{agent.last_seen_at
					? `${t("agents.lastSeen")}: ${formatDate(agent.last_seen_at) ?? t("agents.unknown")}`
					: t("agents.neverSeen")}
			</AppText>
		</AppPressable>
	);
}

export function SessionRow({
	session,
	searchQuery,
}: {
	session: CloudSession;
	searchQuery?: string;
}) {
	const router = useRouter();
	const t = useI18n();
	return (
		<AppPressable
			accessibilityRole="button"
			className="gap-2 rounded-2xl bg-surface px-4 py-4"
			onPress={() => {
				const { search } = sessionDetailLink(session, { searchQuery });
				router.push({
					pathname: "/sessions/[sessionId]",
					params: {
						sessionId: session.id,
						...(search.matchKind ? { matchKind: search.matchKind } : {}),
						...(search.matchPosition !== undefined
							? { matchPosition: String(search.matchPosition) }
							: {}),
						...(search.matchRevision ? { matchRevision: search.matchRevision } : {}),
						...(search.matchQuery ? { matchQuery: search.matchQuery } : {}),
					},
				});
			}}
		>
			<AppView className="flex-row items-center justify-between gap-3">
				<AppText numberOfLines={2} className="flex-1 text-base font-semibold text-foreground">
					{sessionDisplayName(session)}
				</AppText>
				<AppText className="text-sm font-semibold text-primary">
					{t("inventory.viewDetails")}
				</AppText>
			</AppView>
			<AppText className="text-sm text-muted">
				{session.agent_display_name ??
					session.agent_name ??
					session.agent_type ??
					t("sessions.unknownAgent")}
			</AppText>
			<AppText className="text-sm text-muted">
				{session.status} · {formatDate(session.last_activity_at) ?? t("sessions.unknownActivity")}
			</AppText>
			{session.search_match ? (
				<AppText numberOfLines={4} className="text-sm text-foreground">
					{session.search_match.excerpt}
				</AppText>
			) : null}
		</AppPressable>
	);
}

export function BackButton() {
	const router = useRouter();
	const t = useI18n();
	return (
		<AppPressable
			accessibilityRole="button"
			className="self-start py-2"
			onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)"))}
		>
			<AppText className="text-base font-semibold text-primary">‹ {t("navigation.back")}</AppText>
		</AppPressable>
	);
}
