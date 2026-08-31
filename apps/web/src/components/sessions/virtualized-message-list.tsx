"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
	windowStartOffset: number;
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
	const handledScrollRequestRef = useRef<string | null>(null);
	const issuedLatestScrollRequestRef = useRef(props.latestScrollRequestId ?? 0);
	const activeLatestScrollRef = useRef<{
		requestId: number;
		reachedBottom: boolean;
		windowKey: string | null;
	} | null>(null);
	const [readyWindowKey, setReadyWindowKey] = useState<string | null>(null);
	const [atBottomWindowKey, setAtBottomWindowKey] = useState<string | null>(null);
	const [measuredList, setMeasuredList] = useState({ windowKey: null as string | null, height: 0 });
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

	const windowKey = scrollParent
		? `${scrollParent === window ? "window" : "container"}:${props.windowStartOffset}`
		: null;
	const scrollToHighlight = useCallback(() => {
		const requestKey = props.highlightScrollRequestKey;
		if (!requestKey) {
			handledScrollRequestRef.current = null;
			return;
		}
		const virtuoso = virtuosoRef.current;
		if (!scrollParent || highlightedRowIndex < 0 || !virtuoso || readyWindowKey !== windowKey) {
			return;
		}
		if (handledScrollRequestRef.current === requestKey) return;
		handledScrollRequestRef.current = requestKey;
		virtuoso.scrollToIndex({
			index: highlightedRowIndex,
			align: "center",
			behavior: "smooth",
		});
	}, [
		highlightedRowIndex,
		props.highlightScrollRequestKey,
		readyWindowKey,
		scrollParent,
		windowKey,
	]);
	useEffect(scrollToHighlight, [scrollToHighlight]);

	const syncPageBottom = useCallback(() => {
		const activeRequest = activeLatestScrollRef.current;
		if (
			!scrollParent ||
			!activeRequest ||
			activeRequest.requestId !== (props.latestScrollRequestId ?? 0) ||
			!activeRequest.reachedBottom ||
			activeRequest.windowKey !== windowKey ||
			props.windowStartOffset !== 0 ||
			atBottomWindowKey !== windowKey ||
			measuredList.windowKey !== windowKey
		) {
			return;
		}
		const scrollHeight =
			scrollParent instanceof HTMLElement
				? scrollParent.scrollHeight
				: document.documentElement.scrollHeight;
		// Keep the shared page scroller aligned while Virtuoso settles dynamic
		// row heights. Scrolling up clears the bottom state and stops following.
		scrollParent.scrollTo({ top: scrollHeight, behavior: "auto" });
	}, [
		atBottomWindowKey,
		measuredList,
		props.latestScrollRequestId,
		props.windowStartOffset,
		scrollParent,
		windowKey,
	]);
	useEffect(syncPageBottom, [syncPageBottom]);

	const requestLatestScroll = useCallback(() => {
		const requestId = props.latestScrollRequestId ?? 0;
		const virtuoso = virtuosoRef.current;
		if (
			!scrollParent ||
			!virtuoso ||
			rows.length === 0 ||
			props.windowStartOffset !== 0 ||
			readyWindowKey !== windowKey ||
			issuedLatestScrollRequestRef.current === requestId
		) {
			return;
		}
		issuedLatestScrollRequestRef.current = requestId;
		activeLatestScrollRef.current = { requestId, reachedBottom: false, windowKey };
		virtuoso.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
	}, [
		props.latestScrollRequestId,
		props.windowStartOffset,
		readyWindowKey,
		rows.length,
		scrollParent,
		windowKey,
	]);
	useEffect(requestLatestScroll, [requestLatestScroll]);

	const handleAtBottomChange = useCallback(
		(atBottom: boolean) => {
			const activeRequest = activeLatestScrollRef.current;
			if (
				activeRequest?.requestId === (props.latestScrollRequestId ?? 0) &&
				activeRequest.windowKey === windowKey
			) {
				if (atBottom) activeRequest.reachedBottom = true;
				else if (activeRequest.reachedBottom) activeLatestScrollRef.current = null;
			}
			setAtBottomWindowKey(atBottom ? windowKey : null);
			props.onAtBottomChange?.(atBottom);
		},
		[props.latestScrollRequestId, props.onAtBottomChange, windowKey],
	);
	const handleTotalListHeightChanged = useCallback(
		(height: number) => {
			setMeasuredList({ windowKey, height });
		},
		[windowKey],
	);
	const handleRangeChanged = useCallback(() => {
		setReadyWindowKey(windowKey);
	}, [windowKey]);

	if (!scrollParent) return <div aria-hidden className="h-px" />;
	const usesWindowScroll = scrollParent === window;
	// A different first-page offset is a discontinuous server window, not a
	// prepend. Remount Virtuoso so the new window can apply its initial anchor.

	return (
		<div data-testid="virtualized-session-timeline">
			<Virtuoso
				key={windowKey}
				ref={virtuosoRef}
				{...(usesWindowScroll
					? { useWindowScroll: true }
					: { customScrollParent: scrollParent as HTMLElement })}
				data={rows}
				firstItemIndex={firstItemIndex}
				computeItemKey={(_index, row) => row.rowKey}
				defaultItemHeight={96}
				increaseViewportBy={{ top: 600, bottom: 900 }}
				atBottomStateChange={handleAtBottomChange}
				totalListHeightChanged={handleTotalListHeightChanged}
				rangeChanged={handleRangeChanged}
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
