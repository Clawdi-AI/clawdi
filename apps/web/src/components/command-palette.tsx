"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
	Brain,
	FolderKanban,
	Key,
	LayoutDashboard,
	type LucideIcon,
	MessageSquare,
	MessagesSquare,
	Plug,
	Settings,
	Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { SearchHit } from "@/lib/api-schemas";
import { IS_HOSTED } from "@/lib/hosted";
import {
	PROJECT_RESOURCE_GROUPS,
	type ProjectResourceId,
	projectResourceDefinitionsForGroup,
	projectResourcePathLabel,
	projectResourceScopeLabel,
} from "@/lib/project-resource-model";
import {
	DEFAULT_SETTINGS_SECTION,
	normalizeSettingsSection,
	settingsQueryHref,
} from "@/lib/settings-routes";
import { useDebouncedValue } from "@/lib/use-debounced";
import { useV2Access } from "@/lib/v2-access";

const RESOURCE_ICONS = {
	projects: FolderKanban,
	skills: Sparkles,
	vaults: Key,
	sessions: MessageSquare,
	memories: Brain,
	connectors: Plug,
} satisfies Record<ProjectResourceId, LucideIcon>;

interface NavShortcut {
	label: string;
	href: string;
	icon: LucideIcon;
	subtitle: string;
	searchText: string;
}

const BASE_NAV_SHORTCUTS: NavShortcut[] = [
	{
		label: "Overview",
		href: "/",
		icon: LayoutDashboard,
		subtitle: "Dashboard",
		searchText: "overview dashboard",
	},
	...PROJECT_RESOURCE_GROUPS.flatMap((group) =>
		projectResourceDefinitionsForGroup(group.id).map((definition) => ({
			label: definition.navLabel,
			href: definition.href,
			icon: RESOURCE_ICONS[definition.id],
			subtitle: projectResourcePathLabel(definition),
			searchText: `${definition.navLabel} ${definition.label} ${group.label} ${projectResourceScopeLabel(
				definition.projectScope,
			)} ${projectResourcePathLabel(definition)}`,
		})),
	),
];

const V2_NAV_SHORTCUTS: NavShortcut[] = [
	{
		label: "Channels",
		href: "/channels",
		icon: MessagesSquare,
		subtitle: "Account resources",
		searchText: "channels telegram discord whatsapp imessage bots messaging",
	},
	{
		label: "Model Providers",
		href: "/ai-providers",
		icon: Sparkles,
		subtitle: "Account resources",
		searchText:
			"model providers ai providers models openai anthropic openrouter gemini mistral byok api key",
	},
];

const TYPE_ICON: Record<SearchHit["type"], LucideIcon> = {
	session: MessageSquare,
	memory: Brain,
	skill: Sparkles,
	vault: Key,
};

const TYPE_LABEL: Record<SearchHit["type"], string> = {
	session: "Sessions",
	memory: "Memories",
	skill: "Skills",
	vault: "Vaults",
};

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
			if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setOpenInternal((prev) => !prev);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
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
	const api = useApi();
	const router = useRouter();
	const v2Access = useV2Access();
	const [query, setQuery] = useState("");
	const debounced = useDebouncedValue(query, 180);
	const navShortcuts = useMemo(() => {
		const settingsShortcut: NavShortcut = {
			label: "Settings",
			href: settingsQueryHref("general"),
			icon: Settings,
			subtitle: "General, Profile, API Keys",
			searchText: "settings general profile api keys model providers billing preferences account",
		};
		return IS_HOSTED && v2Access.canUseV2
			? [...BASE_NAV_SHORTCUTS, settingsShortcut, ...V2_NAV_SHORTCUTS]
			: [...BASE_NAV_SHORTCUTS, settingsShortcut];
	}, [v2Access.canUseV2]);

	// Reset the input when the palette closes so reopening is a fresh state
	// — otherwise stale results from the previous query briefly flash before
	// a new debounce cycle fires.
	useEffect(() => {
		if (!open) setQuery("");
	}, [open]);

	const { data, isFetching } = useQuery({
		queryKey: ["command-search", debounced],
		queryFn: async () =>
			unwrap(await api.GET("/api/search", { params: { query: { q: debounced } } })),
		enabled: open && debounced.trim().length > 0,
		staleTime: 30_000,
		// Keep the last page of results visible while a new debounced query
		// flies out — prevents the palette flashing to "empty" on every
		// keystroke.
		placeholderData: keepPreviousData,
	});

	const jump = useCallback(
		(href: string) => {
			onOpenChange(false);
			if (href.startsWith("?settings=") && typeof window !== "undefined") {
				const section =
					normalizeSettingsSection(new URLSearchParams(href).get("settings")) ??
					DEFAULT_SETTINGS_SECTION;
				router.push(settingsQueryHref(section, new URLSearchParams(window.location.search)));
				return;
			}
			router.push(href);
		},
		[router, onOpenChange],
	);

	// Group hits by type — cmdk groups handle the visual separator/label.
	const grouped = useMemo(() => {
		const g: Partial<Record<SearchHit["type"], SearchHit[]>> = {};
		for (const hit of data?.results ?? []) {
			const existing = g[hit.type] ?? [];
			existing.push(hit);
			g[hit.type] = existing;
		}
		return g;
	}, [data]);

	const hasQuery = debounced.trim().length > 0;
	const normalizedQuery = debounced.trim().toLowerCase();
	const navMatches = useMemo(
		() =>
			normalizedQuery
				? navShortcuts.filter((s) => s.searchText.toLowerCase().includes(normalizedQuery))
				: navShortcuts,
		[navShortcuts, normalizedQuery],
	);

	// Whether we have a stale results payload we can keep showing while a
	// new debounced query is in flight.
	const hasStaleResults = hasQuery && (data?.results.length ?? 0) > 0;

	// Show "no results" only when (a) the debounced query is active, (b)
	// fetching is finished, (c) we don't have any results. Previously we
	// flashed through an in-between state each keystroke.
	const showEmpty =
		hasQuery &&
		!isFetching &&
		!hasStaleResults &&
		navMatches.length === 0 &&
		(data?.results.length ?? 0) === 0;

	return (
		<CommandDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Search"
			description="Open a page or search sessions, memories, skills, and vaults. Use the Search button in the sidebar or Cmd/Ctrl+K."
			// cmdk does its own filtering by default — we do server-side, so
			// disable client filter and trust the API's ranking.
			shouldFilter={false}
		>
			<div className="relative">
				<CommandInput
					value={query}
					onValueChange={setQuery}
					placeholder="Search sessions, memories, skills, vaults…"
				/>
				{hasQuery && isFetching ? (
					<Spinner className="pointer-events-none absolute top-3.5 right-4 size-4 text-muted-foreground" />
				) : null}
			</div>
			{/* Fixed min-height: stops the dialog from jumping as the user types
			    (switching between 6 nav shortcuts → N result rows → empty). */}
			<CommandList className="min-h-[320px]">
				{showEmpty ? <CommandEmpty>No results for "{debounced}".</CommandEmpty> : null}

				{/* First-fetch state: query typed but no prior data yet — show a
				    neutral loading row inside the list so the dialog isn't
				    just an empty box while the debounce + network settles. */}
				{hasQuery && isFetching && !hasStaleResults ? (
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
								onSelect={() => jump(s.href)}
								className="gap-2"
							>
								<s.icon className="size-4 shrink-0" />
								<div className="flex min-w-0 flex-col">
									<span className="truncate">{s.label}</span>
									<span className="truncate text-xs text-muted-foreground">{s.subtitle}</span>
								</div>
							</CommandItem>
						))}
					</CommandGroup>
				) : null}

				{hasQuery
					? (["session", "memory", "skill", "vault"] as const).map((type, i) => {
							const hits = grouped[type];
							if (!hits?.length) return null;
							const Icon = TYPE_ICON[type];
							return (
								<div key={type}>
									{i > 0 ? <CommandSeparator /> : null}
									<CommandGroup heading={TYPE_LABEL[type]}>
										{hits.map((hit) => (
											<CommandItem
												key={`${hit.type}-${hit.id}`}
												value={`${hit.type}-${hit.id}`}
												onSelect={() => jump(hit.href)}
												className="gap-2"
											>
												<Icon className="size-4 shrink-0 text-muted-foreground" />
												<div className="flex min-w-0 flex-col">
													<span className="truncate">{hit.title}</span>
													{hit.subtitle ? (
														<span className="truncate text-xs text-muted-foreground">
															{hit.subtitle}
														</span>
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
		</CommandDialog>
	);
}
