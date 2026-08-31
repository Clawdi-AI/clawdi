"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
	buildSessionTimelineRows,
	type SessionTimelineListProps,
	SessionTimelineRowView,
} from "@/components/sessions/message-list";
import { findScrollableContainer } from "@/lib/scroll-container";
import { useIsomorphicLayoutEffect } from "@/lib/use-isomorphic-layout-effect";

const DASHBOARD_SCROLL_CONTAINER_ID = "dashboard-scroll-container";

interface VirtualizedSessionTimelineListProps extends SessionTimelineListProps {
	totalItemCount: number;
	onAtBottomChange?: (atBottom: boolean) => void;
	highlightScrollRequestKey?: string | null;
	latestScrollRequestId?: number;
}

/**
 * Windowed dashboard renderer for variable-height Markdown and tool activity.
 * React Virtuoso owns measurement and scroll anchoring. Public shares keep the
 * static renderer; dashboard data is client-fetched, so its SSR shell is empty.
 */
export function VirtualizedSessionTimelineList(props: VirtualizedSessionTimelineListProps) {
	const [scrollParent, setScrollParent] = useState<HTMLElement | Window | null>(null);
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const rows = useMemo(
		() =>
			buildSessionTimelineRows(
				[...props.items].reverse(),
				props.itemKeys ? [...props.itemKeys].reverse() : props.itemKeys,
			),
		[props.itemKeys, props.items],
	);
	const highlightedRowIndex = props.highlightedMessageKey
		? rows.findIndex((row) => row.rowKey === props.highlightedMessageKey)
		: -1;
	const initialHighlightedRowIndex = props.highlightScrollRequestKey ? highlightedRowIndex : -1;
	const handledScrollRequestRef = useRef<string | null>(
		initialHighlightedRowIndex >= 0 ? (props.highlightScrollRequestKey ?? null) : null,
	);
	const handledLatestScrollRequestRef = useRef(props.latestScrollRequestId ?? 0);
	// `firstItemIndex` is React Virtuoso's documented inverse-scrolling
	// contract. It decreases by exactly the number of visual rows prepended,
	// preserving the viewport while older pages load above the conversation.
	const firstItemIndex = Math.max(1, props.totalItemCount - rows.length + 1);

	useIsomorphicLayoutEffect(() => {
		const resolveScrollParent = () => {
			setScrollParent(
				findScrollableContainer(document.getElementById(DASHBOARD_SCROLL_CONTAINER_ID)),
			);
		};
		resolveScrollParent();
		window.addEventListener("resize", resolveScrollParent);
		return () => window.removeEventListener("resize", resolveScrollParent);
	}, []);

	useEffect(() => {
		const requestKey = props.highlightScrollRequestKey;
		if (!requestKey) {
			handledScrollRequestRef.current = null;
			return;
		}
		const virtuoso = virtuosoRef.current;
		if (!scrollParent || highlightedRowIndex < 0 || !virtuoso) return;
		if (handledScrollRequestRef.current === requestKey) return;
		handledScrollRequestRef.current = requestKey;
		virtuoso.scrollToIndex({
			index: highlightedRowIndex,
			align: "center",
			behavior: "smooth",
		});
	}, [highlightedRowIndex, props.highlightScrollRequestKey, scrollParent]);

	useEffect(() => {
		const requestId = props.latestScrollRequestId ?? 0;
		const virtuoso = virtuosoRef.current;
		if (
			!scrollParent ||
			!virtuoso ||
			rows.length === 0 ||
			handledLatestScrollRequestRef.current === requestId
		) {
			return;
		}
		handledLatestScrollRequestRef.current = requestId;
		virtuoso.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
	}, [props.latestScrollRequestId, rows.length, scrollParent]);

	if (!scrollParent) return <div aria-hidden className="h-px" />;
	const usesWindowScroll = scrollParent === window;

	return (
		<div data-testid="virtualized-session-timeline">
			<Virtuoso
				key={usesWindowScroll ? "window" : "container"}
				ref={virtuosoRef}
				{...(usesWindowScroll
					? { useWindowScroll: true }
					: { customScrollParent: scrollParent as HTMLElement })}
				data={rows}
				firstItemIndex={firstItemIndex}
				computeItemKey={(_index, row) => row.rowKey}
				defaultItemHeight={96}
				increaseViewportBy={{ top: 600, bottom: 900 }}
				atBottomStateChange={props.onAtBottomChange}
				initialTopMostItemIndex={
					initialHighlightedRowIndex >= 0
						? { index: initialHighlightedRowIndex, align: "center" }
						: { index: "LAST", align: "end" }
				}
				itemContent={(_index, row) => (
					<SessionTimelineRowView
						row={row}
						agentType={props.agentType}
						userAvatar={props.userAvatar}
						userName={props.userName}
						highlightedMessageKey={props.highlightedMessageKey}
						highlightQuery={props.highlightQuery}
						deferOffscreenRendering={false}
					/>
				)}
			/>
		</div>
	);
}
