import type { paths } from "../api/api.generated";

export type SessionListQuery = NonNullable<paths["/v1/sessions"]["get"]["parameters"]["query"]>;

export function sessionDetailQueryKey(sessionId: string) {
	return [
		"get",
		"/v1/sessions/{session_id}",
		{ params: { path: { session_id: sessionId } } },
	] as const;
}
