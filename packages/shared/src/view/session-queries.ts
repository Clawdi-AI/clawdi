import type { paths } from "../api/api.generated";
import { normalizeSessionListQuery } from "../api/session-query";

export type SessionListQuery = NonNullable<paths["/v1/sessions"]["get"]["parameters"]["query"]>;

export function sessionListQueryKey(query: SessionListQuery = {}) {
	return ["get", "/v1/sessions", { params: { query: normalizeSessionListQuery(query) } }] as const;
}

export function sessionDetailQueryKey(sessionId: string) {
	return [
		"get",
		"/v1/sessions/{session_id}",
		{ params: { path: { session_id: sessionId } } },
	] as const;
}
