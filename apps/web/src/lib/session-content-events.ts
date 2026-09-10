import type { components } from "@clawdi/shared/api";
import type { QueryClient } from "@tanstack/react-query";
import { sessionDetailQueryKey } from "@/lib/session-queries";

type Detail = components["schemas"]["SessionDetailResponse"];
type ContentVersion = Pick<
	Detail,
	"has_content" | "content_hash" | "content_protocol" | "event_head_hash"
>;

export function parseContentVersion(data: string): ContentVersion | null {
	try {
		const value: unknown = JSON.parse(data);
		if (!value || typeof value !== "object") return null;
		if (
			!("has_content" in value) ||
			typeof value.has_content !== "boolean" ||
			!("content_hash" in value) ||
			!(value.content_hash === null || typeof value.content_hash === "string") ||
			!("event_head_hash" in value) ||
			!(value.event_head_hash === null || typeof value.event_head_hash === "string") ||
			!("content_protocol" in value) ||
			!(value.content_protocol === "snapshot-v1" || value.content_protocol === "events-v1")
		)
			return null;
		return {
			has_content: value.has_content,
			content_hash: value.content_hash,
			content_protocol: value.content_protocol,
			event_head_hash: value.event_head_hash,
		};
	} catch {
		return null;
	}
}

export function sessionContentRevision(detail: ContentVersion): string | null {
	if (detail.content_protocol === "events-v1") {
		return detail.event_head_hash ? `events:${detail.event_head_hash}` : null;
	}
	return detail.content_hash ? `snapshot:${detail.content_hash}` : null;
}

export function sameContentVersion(detail: ContentVersion, version: ContentVersion): boolean {
	return (
		detail.has_content === version.has_content &&
		detail.content_hash === version.content_hash &&
		detail.content_protocol === version.content_protocol &&
		detail.event_head_hash === version.event_head_hash
	);
}

export function observeSessionContent(queryClient: QueryClient, sessionId: string) {
	let disposed = false;
	let pending: ContentVersion | null = null;
	const queryKey = sessionDetailQueryKey(sessionId);
	const reconcile = () => {
		if (disposed || !pending) return;
		const state = queryClient.getQueryState<Detail>(queryKey);
		// Let an initial/in-flight detail finish before deciding whether it
		// already includes the committed content. No cancel/refetch loop.
		if (!state?.data || state.fetchStatus !== "idle") return;
		const version = pending;
		pending = null;
		if (sameContentVersion(state.data, version)) return;
		void queryClient.invalidateQueries({ queryKey, exact: true }).catch(() => {
			// The query owns retries and the page's existing error surface.
		});
	};
	const unsubscribe = queryClient.getQueryCache().subscribe(reconcile);
	return {
		receive(version: ContentVersion) {
			if (!disposed) {
				pending = version;
				reconcile();
			}
		},
		clear() {
			pending = null;
		},
		dispose() {
			disposed = true;
			pending = null;
			unsubscribe();
		},
	};
}
