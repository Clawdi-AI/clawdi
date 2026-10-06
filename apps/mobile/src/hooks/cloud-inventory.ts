import {
	ApiClientError,
	type components,
	normalizeSessionListQuery,
	type SessionListQuery,
} from "@clawdi/shared/api";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMobileApi } from "@/lib/api-provider";
import { nextSessionPage } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

export type CloudAgent = components["schemas"]["AgentResponse"];

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

export function formatDate(value: string | null | undefined): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
		date,
	);
}
