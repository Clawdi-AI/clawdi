"use client";

import {
	isSearchQueryReady,
	SEARCH_QUERY_MAX_LENGTH,
	SEARCH_QUERY_MIN_LENGTH,
} from "@clawdi/shared/consts";
import { keepPreviousData } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
	Bot,
	Brain,
	FolderKanban,
	Key,
	type LucideIcon,
	MessageSquare,
	Settings,
	Sparkles,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { SearchHighlightedText } from "@/components/search-highlighted-text";
import { SessionSearchMatchExcerpt } from "@/components/sessions/search-match-excerpt";
import { TruncatedText } from "@/components/truncated-text";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { useOpenApi } from "@/lib/api";
import type { SearchHit } from "@/lib/api-schemas";
import { IS_HOSTED } from "@/lib/hosted";
import { consoleCommandPaletteItems } from "@/lib/navigation-model";
import { useProductAccess } from "@/lib/product-access";
import { searchTerms } from "@/lib/search-highlight";
import { sessionDetailLink } from "@/lib/session-search-anchor";
import type { SettingsSectionId } from "@/lib/settings-routes";
import { useDebouncedValue } from "@/lib/use-debounced";

interface NavShortcut {
	label: string;
	href: string;
	settingsSection?: SettingsSectionId;
	icon: LucideIcon;
	subtitle: string;
	searchText: string;
}

const TYPE_ICON: Record<SearchHit["type"], LucideIcon> = {
	agent: Bot,
	session: MessageSquare,
	memory: Brain,
	project: FolderKanban,
	skill: Sparkles,
	vault: Key,
};

const TYPE_LABEL: Record<SearchHit["type"], string> = {
	agent: "Agents",
	session: "Sessions",
	memory: "Memories",
	project: "Projects",
	skill: "Skills",
	vault: "Vaults",
};
const SEARCH_RESULT_TYPES = ["agent", "session", "memory", "project", "skill", "vault"] as const;

const COMMAND_RESULT_ROW_CLASS = "items-start gap-2 py-2.5";
const COMMAND_RESULT_TEXT_CLASS = "flex min-w-0 flex-col gap-0.5";

interface PaletteContextValue {
	open: boolean;
	setOpen: (open: boolean) => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

export function useCommandPalette() {
	const ctx = useContext(PaletteContext);
	if (!ctx) throw new Error("useCommandPalette must be used inside CommandPaletteProvider");
	return ctx;
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
	const [open, setOpenInternal] = useState(false);

	const setOpen = useCallback((next: boolean) => {
		setOpenInternal(next);
	}, []);

	useEffect(() => {
		// Global Cmd+K / Ctrl+K — mirrors Linear, Vercel, GitHub. We skip when
		// the user is typing in a form field other than our own search input;
		// cmdk already grabs focus inside the dialog so we just need to open it.
		const handler = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setOpenInternal((prev) => !prev);
			}
		};
		document.addEventListener("keydown", handler, true);
		return () => document.removeEventListener("keydown", handler, true);
	}, []);

	const value = useMemo(() => ({ open, setOpen }), [open, setOpen]);

	return (
		<PaletteContext.Provider value={value}>
			{children}
			<CommandPalette open={open} onOpenChange={setOpen} />
		</PaletteContext.Provider>
	);
}

function CommandPalette({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const api = useOpenApi();
	const router = useRouter();
	const hostedAccess = useProductAccess();
	const [query, setQuery] = useState("");
	const debounced = useDebouncedValue(query, 180);
	const searchQuery = debounced.trim();
	const remoteSearchReady = isSearchQueryReady(searchQuery);
	const navShortcuts = useMemo(() => {
		const shortcuts: NavShortcut[] = consoleCommandPaletteItems(false).map((item) => ({
			label: item.label,
			href: item.href,
			icon: item.icon,
			subtitle: item.commandPalette.subtitle,
			searchText: item.commandPalette.searchText,
		}));
		const settingsShortcut: NavShortcut = {
			label: "Settings",
			href: ".",
			settingsSection: "general",
			icon: Settings,
			subtitle: "General, Profile, API Keys",
			searchText: "settings general profile api keys model providers billing preferences account",
		};
		shortcuts.push(settingsShortcut);
		if (IS_HOSTED && hostedAccess.canCreateCloudAgents) {
			shortcuts.push(
				...consoleCommandPaletteItems(true)
					.filter((item) => item.availability === "cloud")
					.map((item) => ({
						label: item.label,
						href: item.href,
						icon: item.icon,
						subtitle: item.commandPalette.subtitle,
						searchText: item.commandPalette.searchText,
					})),
			);
		}
		return shortcuts;
	}, [hostedAccess.canCreateCloudAgents]);

	const { data, isFetching } = api.useQuery(
		"get",
		"/v1/search",
		{ params: { query: { q: searchQuery } } },
		{
			enabled: open && remoteSearchReady,
			staleTime: 30_000,
			// Keep the last page of results visible while a new debounced query
			// flies out — prevents the palette flashing to "empty" on every
			// keystroke.
			placeholderData: keepPreviousData,
		},
	);

	const jump = useCallback(
		(href: string) => {
			onOpenChange(false);
			if (/^https?:\/\//i.test(href) && typeof window !== "undefined") {
				window.location.assign(href);
				return;
			}
			void router.navigate({ href });
		},
		[router, onOpenChange],
	);
	const openSettings = useCallback(
		(section: SettingsSectionId) => {
			onOpenChange(false);
			void router.navigate({
				to: ".",
				search: (current) => ({ ...current, settings: section }),
				hash: true,
				replace: true,
			});
		},
		[onOpenChange, router],
	);
	const openSearchHit = useCallback(
		(hit: SearchHit) => {
			if (hit.type !== "session") {
				jump(hit.href);
				return;
			}
			onOpenChange(false);
			void router.navigate({
				...sessionDetailLink(
					{ id: hit.id, search_match: hit.search_match },
					{ searchQuery: data?.query },
				),
			});
		},
		[data?.query, jump, onOpenChange, router],
	);

	// Group hits by type — cmdk groups handle the visual separator/label.
	const grouped = useMemo(() => {
		const g: Partial<Record<SearchHit["type"], SearchHit[]>> = {};
		if (!remoteSearchReady) return g;
		for (const hit of data?.results ?? []) {
			const existing = g[hit.type] ?? [];
			existing.push(hit);
			g[hit.type] = existing;
		}
		return g;
	}, [data, remoteSearchReady]);
	const resultGroups = useMemo(
		() =>
			SEARCH_RESULT_TYPES.flatMap((type) => {
				const hits = grouped[type];
				return hits?.length ? [{ type, hits }] : [];
			}),
		[grouped],
	);

	const hasQuery = searchQuery.length > 0;
	const normalizedTerms = useMemo(
		() => searchTerms(searchQuery).map((term) => term.toLocaleLowerCase()),
		[searchQuery],
	);
	const navMatches = useMemo(
		() =>
			normalizedTerms.length > 0
				? navShortcuts.filter((shortcut) => {
						const text = shortcut.searchText.toLocaleLowerCase();
						return normalizedTerms.every((term) => text.includes(term));
					})
				: navShortcuts,
		[navShortcuts, normalizedTerms],
	);

	// Whether we have a stale results payload we can keep showing while a
	// new debounced query is in flight.
	const hasStaleResults = remoteSearchReady && (data?.results.length ?? 0) > 0;
	const resultQuery = data?.query ?? searchQuery;

	// Show "no results" only when (a) the debounced query is active, (b)
	// fetching is finished, (c) we don't have any results. Previously we
	// flashed through an in-between state each keystroke.
	const showEmpty =
		remoteSearchReady &&
		!isFetching &&
		!hasStaleResults &&
		navMatches.length === 0 &&
		(data?.results.length ?? 0) === 0;

	return (
		<CommandDialog
			open={open}
			onOpenChange={onOpenChange}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) setQuery("");
			}}
			title="Search"
			description="Open a page or search agents, sessions, memories, projects, skills, and vaults. Use the Search button in the sidebar or Cmd/Ctrl+K."
		>
			<Command label="Global search" shouldFilter={false}>
				<div className="relative">
					<CommandInput
						value={query}
						onValueChange={setQuery}
						placeholder="Search agents, sessions, memories, projects, skills, vaults…"
						maxLength={SEARCH_QUERY_MAX_LENGTH}
					/>
					{remoteSearchReady && isFetching ? (
						<Spinner className="pointer-events-none absolute top-3.5 right-4 size-4 text-muted-foreground" />
					) : null}
				</div>
				{/* Fixed min-height: stops the dialog from jumping as the user types
				    (switching between 6 nav shortcuts → N result rows → empty). */}
				<CommandList className="min-h-[320px]">
					{hasQuery && !remoteSearchReady ? (
						<div role="status" className="px-3 py-2 text-xs text-muted-foreground">
							Type at least {SEARCH_QUERY_MIN_LENGTH} characters to search your workspace.
						</div>
					) : null}
					{showEmpty ? <CommandEmpty>No results for "{searchQuery}".</CommandEmpty> : null}

					{/* First-fetch state: query typed but no prior data yet — show a
					    neutral loading row inside the list so the dialog isn't
					    just an empty box while the debounce + network settles. */}
					{remoteSearchReady && isFetching && !hasStaleResults ? (
						<div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
							<Spinner />
							Searching…
						</div>
					) : null}

					{navMatches.length > 0 ? (
						<CommandGroup heading="Open a Page">
							{navMatches.map((s) => (
								<CommandItem
									key={s.href}
									value={s.searchText}
									onSelect={() =>
										s.settingsSection ? openSettings(s.settingsSection) : jump(s.href)
									}
									className={COMMAND_RESULT_ROW_CLASS}
								>
									<s.icon className="mt-0.5 size-4 shrink-0" />
									<div className={COMMAND_RESULT_TEXT_CLASS}>
										<TruncatedText>{s.label}</TruncatedText>
										<TruncatedText className="text-xs text-muted-foreground">
											{s.subtitle}
										</TruncatedText>
									</div>
								</CommandItem>
							))}
						</CommandGroup>
					) : null}

					{remoteSearchReady
						? resultGroups.map(({ type, hits }, i) => {
								const Icon = TYPE_ICON[type];
								return (
									<div key={type}>
										{i > 0 ? <CommandSeparator /> : null}
										<CommandGroup heading={TYPE_LABEL[type]}>
											{hits.map((hit) => (
												<CommandItem
													key={`${hit.type}-${hit.id}`}
													value={`${hit.type}-${hit.id}`}
													onSelect={() => openSearchHit(hit)}
													className={COMMAND_RESULT_ROW_CLASS}
												>
													<Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
													<div className={COMMAND_RESULT_TEXT_CLASS}>
														<TruncatedText title={hit.title}>
															<SearchHighlightedText text={hit.title} query={resultQuery} />
														</TruncatedText>
														{hit.type === "session" && hit.search_match ? (
															<SessionSearchMatchExcerpt
																match={hit.search_match}
																query={resultQuery}
																className="line-clamp-2 text-xs leading-4 text-muted-foreground"
															/>
														) : hit.subtitle ? (
															<TruncatedText className="text-xs text-muted-foreground">
																<SearchHighlightedText text={hit.subtitle} query={resultQuery} />
															</TruncatedText>
														) : null}
													</div>
												</CommandItem>
											))}
										</CommandGroup>
									</div>
								);
							})
						: null}
				</CommandList>
			</Command>
		</CommandDialog>
	);
}
