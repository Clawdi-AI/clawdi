"use client";

import { Link, useRouter } from "@tanstack/react-router";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import type { SessionMessagesPage } from "@/lib/api-schemas";
import {
	type SessionSearchAnchor,
	sessionDetailSearchLink,
	sessionSearchMatchLink,
} from "@/lib/session-search-anchor";

type SearchNavigation = NonNullable<SessionMessagesPage["search_navigation"]>;

function MatchButton({
	label,
	anchor,
	sessionId,
	query,
	returnTo,
	icon,
}: {
	label: string;
	anchor: SessionSearchAnchor | null | undefined;
	sessionId: string;
	query: string;
	returnTo?: string;
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
			nativeButton={false}
			render={
				<Link
					{...sessionSearchMatchLink(sessionId, anchor, { searchQuery: query, returnTo })}
					replace
					resetScroll={false}
				/>
			}
			aria-label={label}
			title={label}
		>
			{icon}
		</Button>
	);
}

export function SessionSearchNavigation({
	sessionId,
	query,
	navigation,
	returnTo,
	isSearching = false,
	hasSearchError = false,
}: {
	sessionId: string;
	query: string;
	navigation?: SearchNavigation | null;
	returnTo?: string;
	isSearching?: boolean;
	hasSearchError?: boolean;
}) {
	const router = useRouter();
	const [draftQuery, setDraftQuery] = useState(query);
	useEffect(() => {
		// Keep transient trailing whitespace while the URL stores the normalized query.
		setDraftQuery((current) => (query && current.trim() === query ? current : query));
	}, [query]);
	const activeNavigation = isSearching || hasSearchError ? null : navigation;
	const updateQuery = (next: string) => {
		setDraftQuery(next);
		void router.navigate({
			...sessionDetailSearchLink(sessionId, next, { returnTo }),
			replace: true,
			resetScroll: false,
		});
	};
	const navigateToMatch = (anchor: SessionSearchAnchor | null | undefined) => {
		if (!anchor) return;
		void router.navigate({
			...sessionSearchMatchLink(sessionId, anchor, { searchQuery: query, returnTo }),
			replace: true,
			resetScroll: false,
		});
	};

	return (
		<nav
			aria-label="Search this session"
			className="sticky top-(--header-height) z-10 -mx-1 flex min-w-0 flex-col gap-2 border-y bg-background/95 px-1 py-2 text-xs text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:flex-row sm:items-center"
		>
			<SearchInput
				value={draftQuery}
				onChange={updateQuery}
				placeholder="Search this session…"
				ariaLabel="Search this session"
				className="min-w-0 flex-1"
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
				<div className="flex min-h-8 shrink-0 items-center justify-end gap-2">
					<span className="shrink-0 tabular-nums text-foreground" aria-live="polite">
						{hasSearchError
							? "Unavailable"
							: isSearching
								? "Searching…"
								: activeNavigation
									? `${activeNavigation.index} of ${activeNavigation.total}`
									: "No matches"}
					</span>
					<div className="flex shrink-0 items-center">
						<MatchButton
							label="Previous match"
							anchor={activeNavigation?.previous}
							sessionId={sessionId}
							query={query}
							returnTo={returnTo}
							icon={<ChevronUp />}
						/>
						<MatchButton
							label="Next match"
							anchor={activeNavigation?.next}
							sessionId={sessionId}
							query={query}
							returnTo={returnTo}
							icon={<ChevronDown />}
						/>
					</div>
				</div>
			) : null}
		</nav>
	);
}
