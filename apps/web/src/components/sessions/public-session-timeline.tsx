"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import {
	buildSessionTimelineRows,
	SessionTimelineRowView,
} from "@/components/sessions/message-list";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { SessionMessagesPage } from "@/lib/api-schemas";

const PAGE_SIZE = 100;

export function PublicSessionTimeline({
	shareId,
	source,
	initialPage,
	agentType,
}: {
	shareId: string;
	source: "share" | "legacy";
	initialPage: SessionMessagesPage;
	agentType: string | null;
}) {
	const api = useApi();
	const query = useInfiniteQuery({
		queryKey: ["public-session-share-messages", source, shareId],
		initialPageParam: 0,
		initialData: { pages: [initialPage], pageParams: [0] },
		queryFn: async ({ pageParam }) => {
			if (source === "share") {
				return unwrap(
					await api.GET("/v1/public/session-shares/{share_id}/messages", {
						params: {
							path: { share_id: shareId },
							query: { offset: pageParam, limit: PAGE_SIZE },
						},
					}),
				);
			}
			return unwrap(
				await api.GET("/v1/public/sessions/{session_id}/messages", {
					params: {
						path: { session_id: shareId },
						query: { offset: pageParam, limit: PAGE_SIZE, direction: "asc" },
					},
				}),
			);
		},
		getNextPageParam: (lastPage) => {
			const nextOffset = lastPage.offset + lastPage.items.length;
			return nextOffset < lastPage.total ? nextOffset : undefined;
		},
		staleTime: Number.POSITIVE_INFINITY,
	});
	const messages = query.data.pages.flatMap((page) => page.items);
	const rows = useMemo(() => buildSessionTimelineRows(messages), [messages]);

	return (
		<Virtuoso
			useWindowScroll
			data={rows}
			computeItemKey={(_index, row) => row.rowKey}
			defaultItemHeight={96}
			initialItemCount={Math.min(rows.length, PAGE_SIZE)}
			increaseViewportBy={{ top: 400, bottom: 800 }}
			endReached={() => {
				if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
					void query.fetchNextPage();
				}
			}}
			itemContent={(_index, row) => (
				<SessionTimelineRowView
					row={row}
					agentType={agentType}
					userName="User"
					deferOffscreenRendering={false}
				/>
			)}
			components={{
				Footer: () =>
					query.isFetchingNextPage ? (
						<div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
							<Spinner className="size-3.5" /> Loading more…
						</div>
					) : query.isFetchNextPageError ? (
						<div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
							<span>Couldn’t load more messages.</span>
							<Button variant="ghost" size="xs" onClick={() => void query.fetchNextPage()}>
								Retry
							</Button>
						</div>
					) : null,
			}}
		/>
	);
}
