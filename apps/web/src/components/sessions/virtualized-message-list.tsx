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
	direction: "asc" | "desc";
	totalItemCount: number;
	hasMoreItems: boolean;
	isLoadingMore: boolean;
	onLoadMore: () => void;
}

/**
 * Windowed dashboard renderer for variable-height Markdown and tool activity.
 * React Virtuoso owns measurement and scroll anchoring. Public shares keep the
 * static renderer; dashboard data is client-fetched, so its SSR shell is empty.
 */
export function VirtualizedSessionTimelineList(props: VirtualizedSessionTimelineListProps) {
	const [scrollParent, setScrollParent] = useState<HTMLElement | Window | null>(null);
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const rows = useMemo(() => {
		if (props.direction === "desc") {
			return buildSessionTimelineRows(props.items, props.itemKeys);
		}
		return buildSessionTimelineRows(
			[...props.items].reverse(),
			props.itemKeys ? [...props.itemKeys].reverse() : props.itemKeys,
		);
	}, [props.direction, props.itemKeys, props.items]);
	const highlightedRowIndex = props.highlightedMessageKey
		? rows.findIndex((row) => row.rowKey === props.highlightedMessageKey)
		: -1;
	// `firstItemIndex` is React Virtuoso's documented inverse-scrolling
	// contract. It decreases by exactly the number of visual rows prepended,
	// preserving the viewport while older pages load above the conversation.
	const firstItemIndex =
		props.direction === "asc" ? Math.max(1, props.totalItemCount - rows.length + 1) : undefined;

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
		if (!scrollParent || highlightedRowIndex < 0) return;
		const frame = requestAnimationFrame(() => {
			virtuosoRef.current?.scrollToIndex({
				index: highlightedRowIndex,
				align: "center",
				behavior: "smooth",
			});
		});
		return () => cancelAnimationFrame(frame);
	}, [highlightedRowIndex, scrollParent]);

	if (!scrollParent) return <div aria-hidden className="h-px" />;
	const usesWindowScroll = scrollParent === window;

	return (
		<div data-testid="virtualized-session-timeline">
			<Virtuoso
				key={`${usesWindowScroll ? "window" : "container"}:${props.direction}`}
				ref={virtuosoRef}
				{...(usesWindowScroll
					? { useWindowScroll: true }
					: { customScrollParent: scrollParent as HTMLElement })}
				data={rows}
				firstItemIndex={firstItemIndex}
				computeItemKey={(_index, row) => row.rowKey}
				defaultItemHeight={96}
				increaseViewportBy={{ top: 600, bottom: 900 }}
				startReached={
					props.direction === "asc" && props.hasMoreItems && !props.isLoadingMore
						? props.onLoadMore
						: undefined
				}
				initialTopMostItemIndex={
					highlightedRowIndex >= 0
						? { index: highlightedRowIndex, align: "center" }
						: props.direction === "asc"
							? { index: rows.length - 1, align: "end" }
							: 0
				}
				itemContent={(_index, row) => (
					<SessionTimelineRowView
						row={row}
						agentType={props.agentType}
						userAvatar={props.userAvatar}
						userName={props.userName}
						highlightedMessageKey={props.highlightedMessageKey}
						highlightedMessageRef={props.highlightedMessageRef}
						highlightQuery={props.highlightQuery}
						deferOffscreenRendering={false}
					/>
				)}
			/>
		</div>
	);
}
