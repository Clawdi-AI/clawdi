"use client";

import { useRouter } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { agentSessionDetailLink } from "@/lib/agent-routes";
import type { SessionMessagesPage } from "@/lib/api-schemas";
import {
	parseSessionTimelineView,
	type SessionSearchAnchor,
	type SessionTimelineView,
	sessionDetailSearchLink,
	sessionSearchMatchLink,
} from "@/lib/session-search-anchor";
import { cn } from "@/lib/utils";

type SearchNavigation = NonNullable<SessionMessagesPage["search_navigation"]>;

function MatchButton({
	label,
	anchor,
	onSelect,
	icon,
}: {
	label: string;
	anchor: SessionSearchAnchor | null | undefined;
	onSelect: (anchor: SessionSearchAnchor) => void;
	icon: React.ReactNode;
}) {
	if (!anchor) {
		return (
			<Button variant="ghost" size="icon-sm" disabled aria-label={label} title={label}>
				{icon}
			</Button>
		);
	}
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			onClick={() => onSelect(anchor)}
			aria-label={label}
			title={label}
		>
			{icon}
		</Button>
	);
}

export function SessionSearchNavigation({
	sessionId,
	agentId,
	query,
	timelineView,
	navigation,
	returnTo,
	isSearching = false,
	hasSearchError = false,
	className,
}: {
	sessionId: string;
	agentId?: string | null;
	query: string;
	timelineView: SessionTimelineView;
	navigation?: SearchNavigation | null;
	returnTo?: string;
	isSearching?: boolean;
	hasSearchError?: boolean;
	className?: string;
}) {
	const router = useRouter();
	const [draftQuery, setDraftQuery] = useState(query);
	useEffect(() => {
		// Keep transient trailing whitespace while the URL stores the normalized query.
		setDraftQuery((current) => (query && current.trim() === query ? current : query));
	}, [query]);
	const activeNavigation = isSearching || hasSearchError ? null : navigation;
	const navigate = (search: Record<string, unknown>) => {
		if (agentId) {
			void router.navigate({
				...agentSessionDetailLink(agentId, sessionId, search),
				replace: true,
				resetScroll: false,
			});
			return;
		}
		void router.navigate({
			to: "/sessions/$id",
			params: { id: sessionId },
			search,
			replace: true,
			resetScroll: false,
		});
	};
	const latestTimelineView = () =>
		parseSessionTimelineView(router.state.location.search.timelineView) ?? timelineView;
	const updateQuery = (next: string) => {
		setDraftQuery(next);
		navigate(
			sessionDetailSearchLink(sessionId, next, {
				returnTo,
				timelineView: latestTimelineView(),
			}).search,
		);
	};
	const navigateToMatch = (anchor: SessionSearchAnchor | null | undefined) => {
		if (!anchor) return;
		navigate(
			sessionSearchMatchLink(sessionId, anchor, {
				searchQuery: query,
				timelineView: latestTimelineView(),
				returnTo,
			}).search,
		);
	};

	return (
		<nav
			aria-label="Search this session"
			className={cn(
				"flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground",
				className,
			)}
		>
			<SearchInput
				value={draftQuery}
				onChange={updateQuery}
				placeholder="Search this session…"
				ariaLabel="Search this session"
				className="min-w-36 flex-1"
				ariaKeyShortcuts="Enter Shift+Enter Escape"
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) return;
					if (event.key === "Escape" && draftQuery) {
						event.preventDefault();
						updateQuery("");
						return;
					}
					if (event.key !== "Enter") return;
					const anchor = event.shiftKey ? activeNavigation?.previous : activeNavigation?.next;
					if (!anchor) return;
					event.preventDefault();
					navigateToMatch(anchor);
				}}
			/>
			{query ? (
				<div className="flex min-h-8 shrink-0 items-center gap-1 border-l pl-1.5">
					<span
						className="inline-flex min-w-10 shrink-0 items-center justify-center gap-1 tabular-nums text-foreground"
						aria-live="polite"
						title={!isSearching && !hasSearchError && !activeNavigation ? "No matches" : undefined}
					>
						{isSearching ? (
							<>
								<LoaderCircle className="size-3.5 animate-spin" />
								<span className="sr-only">Searching</span>
							</>
						) : null}
						{hasSearchError
							? "Unavailable"
							: isSearching
								? null
								: activeNavigation
									? `${activeNavigation.index} / ${activeNavigation.total}`
									: "0 / 0"}
					</span>
					<MatchButton
						label="Previous match"
						anchor={activeNavigation?.previous}
						onSelect={navigateToMatch}
						icon={<ChevronUp />}
					/>
					<MatchButton
						label="Next match"
						anchor={activeNavigation?.next}
						onSelect={navigateToMatch}
						icon={<ChevronDown />}
					/>
				</div>
			) : null}
		</nav>
	);
}
