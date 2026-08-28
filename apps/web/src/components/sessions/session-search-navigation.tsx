"use client";

import { Link, useRouter } from "@tanstack/react-router";
import { ChevronDown, ChevronUp } from "lucide-react";
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
	const activeNavigation = isSearching || hasSearchError ? null : navigation;
	const updateQuery = (next: string) => {
		void router.navigate({
			...sessionDetailSearchLink(sessionId, next, { returnTo }),
			replace: true,
			resetScroll: false,
		});
	};

	return (
		<nav
			aria-label="Search this session"
			className="flex min-w-0 flex-col gap-2 border-y py-2 text-xs text-muted-foreground sm:flex-row sm:items-center"
		>
			<SearchInput
				value={query}
				onChange={updateQuery}
				placeholder="Search this session…"
				ariaLabel="Search this session"
				className="min-w-0 flex-1"
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
