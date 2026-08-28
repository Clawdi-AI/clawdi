"use client";

import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SessionMessagesPage } from "@/lib/api-schemas";
import { type SessionSearchAnchor, sessionSearchMatchLink } from "@/lib/session-search-anchor";

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
}: {
	sessionId: string;
	query: string;
	navigation: SearchNavigation;
	returnTo?: string;
}) {
	return (
		<nav
			aria-label="Search matches"
			className="flex min-w-0 items-center gap-2 border-y py-2 text-xs text-muted-foreground"
		>
			<Search className="size-3.5 shrink-0" />
			<span className="min-w-0 flex-1 truncate" title={query}>
				Matches for <span className="font-medium text-foreground">{query}</span>
			</span>
			<span className="shrink-0 tabular-nums text-foreground">
				{navigation.index} of {navigation.total}
			</span>
			<div className="flex shrink-0 items-center">
				<MatchButton
					label="Previous match"
					anchor={navigation.previous}
					sessionId={sessionId}
					query={query}
					returnTo={returnTo}
					icon={<ChevronUp />}
				/>
				<MatchButton
					label="Next match"
					anchor={navigation.next}
					sessionId={sessionId}
					query={query}
					returnTo={returnTo}
					icon={<ChevronDown />}
				/>
			</div>
		</nav>
	);
}
