"use client";

import type { components } from "@clawdi/shared/api";
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	KeyboardCode,
	KeyboardSensor,
	type Modifier,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRouter, useSearch } from "@tanstack/react-router";
import {
	BookOpen,
	CircleHelp,
	ExternalLink,
	History,
	LayoutDashboard,
	type LucideIcon,
	Mail,
	MessageCircle,
	Search,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useCommandPalette } from "@/components/command-palette";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import {
	AgentSourceBadge,
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
	agentSourceKindLabel,
	agentTextLabel,
	agentTypeLabel,
	displayMachineName,
	LegacyAgentBadge,
} from "@/components/dashboard/agent-label";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { resolveAgentDefaultProject } from "@/components/dashboard/agent-project-scope";
import {
	type AgentCardStatusProjection,
	type AgentTile,
	agentTileMatchesRouteId,
	compareAgentTiles,
	selfManagedAgentTiles,
} from "@/components/dashboard/agents-card";
import { DaemonStatusBadge, type DaemonStatusSource } from "@/components/dashboard/daemon-status";
import { NewAgentButton } from "@/components/dashboard/new-agent-button";
import { IconChip } from "@/components/icon-chip";
import { SettingsDialog } from "@/components/settings-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarSeparator,
	useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserMenuItems } from "@/components/user-menu";
import {
	type AgentOwnershipKind,
	agentOwnershipKindFromId,
	useAgentOwnership,
} from "@/lib/agent-ownership";
import {
	type AgentSectionId,
	agentDeploymentRouteQuery,
	agentDeploymentSelector,
	agentProjectResourceHref,
	agentRouteIdsEqual,
	agentSectionHref,
	parseAgentPathname,
} from "@/lib/agent-routes";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-client";
import {
	availableAppsQueryOptions,
	CONNECTOR_CATALOG_PAGE_SIZE,
	connectionsQueryOptions,
} from "@/lib/connectors-data";
import { IS_HOSTED } from "@/lib/hosted";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import { legacyHostedDashboardUrl } from "@/lib/legacy-hosted-dashboard";
import type { AgentNavigationVariant } from "@/lib/navigation-model";
import {
	AGENT_SECTION_NAVIGATION_ITEMS,
	agentNavigationGroups,
	CANONICAL_NAVIGATION_IDENTITIES,
	consoleNavigationGroups,
	hostedAgentVisibleSectionIds,
} from "@/lib/navigation-model";
import { RESOURCE_TINT_CLASSES } from "@/lib/resource-identity";
import { DEFAULT_SETTINGS_SECTION, type SettingsSectionId } from "@/lib/settings-routes";
import { useHydrated } from "@/lib/use-hydrated";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

type AgentChromeKind = AgentOwnershipKind;
const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";
const HostedUnifiedAgentListSensor = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/use-unified-agent-list").then((m) => ({
				default: m.HostedUnifiedAgentListSensor,
			})),
		)
	: null;

function useAgentChromeKind(
	agent: SidebarEnvironment | null,
	tile: AgentTile | null,
): AgentChromeKind {
	const ownership = useAgentOwnership();
	if (tile) return agentTileChromeKind(tile);
	if (!IS_HOSTED || !agent) return "connected";
	return agentOwnershipKindFromId(agent.id, ownership);
}

const LEGACY_DASHBOARD_TINT = "bg-warning-muted text-warning-muted-foreground";

type SidebarEnvironment = components["schemas"]["AgentResponse"];
const EMPTY_SIDEBAR_ENVIRONMENTS: SidebarEnvironment[] = [];

type SidebarNavItem = {
	id: string;
	label: string;
	href: string;
	icon: LucideIcon;
	tint: string;
	tooltip: string;
	active: boolean;
	external?: boolean;
	prefetch?: () => void;
};

type AgentPrimaryProjectNavigation = {
	id: string;
	contextProjectIds: readonly string[];
};

type ScopedAgentResourceSidebarTarget =
	| { kind: "workspace"; resource: "skills" | "vaults" }
	| { kind: "projects" }
	| null;

export function scopedAgentResourceSidebarTarget(
	pathname: string,
	searchStr: string,
	primaryProjectId: string,
	contextProjectIds: readonly string[],
): ScopedAgentResourceSidebarTarget {
	const route = parseAgentPathname(pathname);
	if (!route || (route.section !== "skills" && route.section !== "vaults")) return null;

	const projectId = new URLSearchParams(searchStr).get("project")?.trim();
	if (!projectId) return null;
	if (agentRouteIdsEqual(projectId, primaryProjectId)) {
		return { kind: "workspace", resource: route.section };
	}
	if (contextProjectIds.some((id) => agentRouteIdsEqual(projectId, id))) {
		return { kind: "projects" };
	}
	return null;
}

const RAIL_DRAG_ACTIVATION_DISTANCE = 10;
const RAIL_KEYBOARD_CODES = {
	start: [KeyboardCode.Space],
	cancel: [KeyboardCode.Esc],
	end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
};

const restrictRailDragToVerticalAxis: Modifier = ({ transform }) => ({
	...transform,
	x: 0,
});

const RAIL_DND_MODIFIERS = [restrictRailDragToVerticalAxis];

function reorderEnvironmentsForCache(
	current: SidebarEnvironment[],
	orderedIds: string[],
): SidebarEnvironment[] {
	const byId = new Map(current.map((env) => [env.id, env]));
	const requested = new Set(orderedIds);
	const reordered = orderedIds
		.map((id) => byId.get(id))
		.filter((env): env is SidebarEnvironment => Boolean(env));
	reordered.push(...current.filter((env) => !requested.has(env.id)));
	return reordered.map((env, index) => ({ ...env, sort_order: index }));
}

function reorderAgentTilesByIndex(current: AgentTile[], from: number, to: number): AgentTile[] {
	return arrayMove(current, from, to).map((tile, index) => ({
		...tile,
		sortOrder: index,
		env: tile.env ? { ...tile.env, sort_order: index } : tile.env,
	}));
}

function agentTileChromeKind(tile: AgentTile): AgentChromeKind {
	if (tile.source === "on-clawdi") return "cloud";
	if (tile.source === "legacy-hosted") return "legacy";
	return "connected";
}

function sameOrder(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

function SidebarNavSection({
	label,
	items,
	before,
	separated = false,
	ariaLabel,
	onNavigate,
}: {
	label: string | null;
	items: SidebarNavItem[];
	before?: React.ReactNode;
	separated?: boolean;
	ariaLabel?: string;
	onNavigate?: () => void;
}) {
	return (
		<SidebarGroup
			role="group"
			className={cn("pt-0", separated && "mt-2 border-t pt-2")}
			aria-label={ariaLabel ?? label ?? undefined}
		>
			{label ? (
				<SidebarGroupLabel className="min-w-0 truncate" title={label}>
					{label}
				</SidebarGroupLabel>
			) : null}
			<SidebarGroupContent>
				<SidebarMenu>
					{before}
					{items.map((item) => {
						const Icon = item.icon;
						return (
							<SidebarMenuItem key={item.id}>
								<SidebarMenuButton
									render={
										item.external ? (
											// biome-ignore lint/a11y/useAnchorContent: Base UI render placeholder; SidebarMenuButton supplies the accessible label.
											<a
												href={item.href}
												target="_blank"
												rel="noopener noreferrer"
												aria-label={`Open ${item.label}`}
												onClick={onNavigate}
											/>
										) : (
											<Link
												to={item.href}
												onClick={onNavigate}
												onMouseEnter={item.prefetch}
												onFocus={item.prefetch}
											/>
										)
									}
									isActive={item.active}
									tooltip={item.tooltip}
								>
									<IconChip size="xs" tint={item.tint}>
										<Icon />
									</IconChip>
									<span>{item.label}</span>
									{item.external ? (
										<ExternalLink className="ml-auto size-3 text-muted-foreground" />
									) : null}
								</SidebarMenuButton>
							</SidebarMenuItem>
						);
					})}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	);
}

function usePrefetchConnectorsCatalog() {
	const api = useOpenApi();
	const queryClient = useQueryClient();
	return useCallback(() => {
		void queryClient.prefetchQuery(
			availableAppsQueryOptions(api, {
				page: 1,
				pageSize: CONNECTOR_CATALOG_PAGE_SIZE,
			}),
		);
		void queryClient.prefetchQuery(connectionsQueryOptions(api));
	}, [api, queryClient]);
}

function ConsoleNavigationSections({
	pathname,
	showCloudFeatures,
	onNavigate,
}: {
	pathname: string;
	showCloudFeatures: boolean;
	onNavigate?: () => void;
}) {
	const prefetchConnectorsCatalog = usePrefetchConnectorsCatalog();
	return consoleNavigationGroups(showCloudFeatures).map((group) => (
		<SidebarNavSection
			key={group.id}
			label={group.label}
			items={group.items.map((item) => ({
				...item,
				active:
					item.href === "/"
						? pathname === item.href
						: pathname === item.href || pathname.startsWith(`${item.href}/`),
				prefetch: item.id === "connectors" ? prefetchConnectorsCatalog : undefined,
			}))}
			separated={group.separated}
			ariaLabel={group.label ?? "Primary navigation"}
			onNavigate={onNavigate}
		/>
	));
}

function AgentSectionList({
	agentId,
	variant,
	visibleSectionIds,
	activeSection,
	primaryProject,
	extraPrimaryItems = [],
	onNavigate,
}: {
	agentId: string;
	variant: AgentNavigationVariant;
	visibleSectionIds?: readonly AgentSectionId[];
	activeSection: AgentSectionId;
	primaryProject?: AgentPrimaryProjectNavigation | null;
	extraPrimaryItems?: SidebarNavItem[];
	onNavigate?: () => void;
}) {
	const { pathname, searchStr } = useLocation({
		select: (location) => ({
			pathname: location.pathname,
			searchStr: location.searchStr,
		}),
	});
	const routeQuery = agentDeploymentRouteQuery(searchStr);
	const prefetchConnectorsCatalog = usePrefetchConnectorsCatalog();
	const groups = agentNavigationGroups(variant, visibleSectionIds);
	const activeAgentRoute = parseAgentPathname(pathname);
	const primaryProjectRouteActive = Boolean(
		primaryProject && agentRouteIdsEqual(activeAgentRoute?.projectId, primaryProject.id),
	);
	const scopedResourceTarget = primaryProject
		? scopedAgentResourceSidebarTarget(
				pathname,
				searchStr,
				primaryProject.id,
				primaryProject.contextProjectIds,
			)
		: null;
	const activePrimaryProjectResource =
		(primaryProjectRouteActive ? activeAgentRoute?.projectResource : null) ??
		(scopedResourceTarget?.kind === "workspace" ? scopedResourceTarget.resource : null);
	const isFlatProjectResourceRoute =
		activeAgentRoute?.section === "skills" || activeAgentRoute?.section === "vaults";
	// Invalid, legacy, and not-yet-resolved flat resource URLs all return through
	// Projects. Keep that safe parent active until an exact Workspace or linked
	// Project context has been proven instead of misleadingly highlighting Overview.
	const activeContextProjectResource =
		scopedResourceTarget?.kind === "projects" ||
		(isFlatProjectResourceRoute && !activePrimaryProjectResource);
	const normalizedActiveSection = groups.some((group) =>
		group.items.some((item) => item.id === activeSection),
	)
		? activeSection
		: "overview";
	const primaryProjectItems = primaryProject
		? (["skills", "vaults"] as const).map((section): SidebarNavItem => {
				const item = AGENT_SECTION_NAVIGATION_ITEMS[section];
				return {
					id: `primary-project-${section}`,
					label: item.label,
					href: agentProjectResourceHref(agentId, primaryProject.id, section, routeQuery),
					icon: item.icon,
					tint: item.tint,
					tooltip: `${item.label} in Workspace`,
					active: activePrimaryProjectResource === section,
				};
			})
		: [];

	return (
		<>
			{groups.map((group) => {
				const items = [
					...group.items.map((item): SidebarNavItem => {
						return {
							id: item.id,
							label: item.label,
							href: agentSectionHref(agentId, item.id, routeQuery),
							icon: item.icon,
							tint: item.tint,
							tooltip: item.tooltip,
							active:
								item.id === "projects"
									? activeContextProjectResource ||
										(normalizedActiveSection === "projects" && !activePrimaryProjectResource)
									: normalizedActiveSection === item.id &&
										!activePrimaryProjectResource &&
										!activeContextProjectResource,
							prefetch: item.id === "connectors" ? prefetchConnectorsCatalog : undefined,
						};
					}),
					...(group.id === "workspace" ? primaryProjectItems : []),
					...(group.id === "primary" ? extraPrimaryItems : []),
				];
				return (
					<SidebarNavSection
						key={group.id}
						label={group.label}
						items={items}
						separated={group.separated}
						ariaLabel={
							group.label ?? (group.id === "settings" ? "Agent settings" : "Primary navigation")
						}
						onNavigate={onNavigate}
					/>
				);
			})}
		</>
	);
}

function AgentFocusSections({
	agentId,
	kind,
	filesAvailable,
	activeSection,
	primaryProject,
	onNavigate,
}: {
	agentId: string;
	kind: Exclude<AgentChromeKind, "unresolved">;
	filesAvailable?: boolean;
	activeSection: AgentSectionId;
	primaryProject?: AgentPrimaryProjectNavigation | null;
	onNavigate?: () => void;
}) {
	const legacyDashboardHref = kind === "legacy" ? legacyHostedDashboardUrl() : null;
	const extraPrimaryItems: SidebarNavItem[] = legacyDashboardHref
		? [
				{
					id: "legacy-dashboard",
					label: "Legacy dashboard",
					href: legacyDashboardHref,
					icon: History,
					tint: LEGACY_DASHBOARD_TINT,
					tooltip: "Open legacy dashboard",
					active: false,
					external: true,
				},
			]
		: [];
	return (
		<AgentSectionList
			agentId={agentId}
			variant={kind === "cloud" ? "hosted" : "connected"}
			visibleSectionIds={
				kind === "cloud" ? hostedAgentVisibleSectionIds(filesAvailable === true) : undefined
			}
			activeSection={activeSection}
			primaryProject={primaryProject}
			extraPrimaryItems={extraPrimaryItems}
			onNavigate={onNavigate}
		/>
	);
}

function AgentFocusHostedFallbackSections({
	agentId,
	activeSection,
	onNavigate,
}: {
	agentId: string;
	activeSection: AgentSectionId;
	onNavigate?: () => void;
}) {
	return (
		<AgentSectionList
			agentId={agentId}
			variant="hosted"
			visibleSectionIds={["overview"]}
			activeSection={activeSection}
			onNavigate={onNavigate}
		/>
	);
}

function AgentFocusLoadingSections({
	agentId,
	activeSection,
	onNavigate,
}: {
	agentId: string;
	activeSection: AgentSectionId;
	onNavigate?: () => void;
}) {
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const routeQuery = agentDeploymentRouteQuery(searchStr);
	const overviewMetadata = AGENT_SECTION_NAVIGATION_ITEMS.overview;
	const overviewItem: SidebarNavItem = {
		id: overviewMetadata.id,
		label: overviewMetadata.label,
		href: agentSectionHref(agentId, "overview", routeQuery),
		icon: overviewMetadata.icon,
		tint: overviewMetadata.tint,
		tooltip: overviewMetadata.tooltip,
		active: activeSection === "overview",
	};

	return (
		<>
			<SidebarNavSection
				label={null}
				items={[overviewItem]}
				ariaLabel="Primary navigation"
				onNavigate={onNavigate}
			/>
			<SidebarGroup role="group" className="pt-0" aria-label="Navigation loading">
				<SidebarGroupContent>
					<SidebarMenu>
						{["70%", "58%", "64%"].map((width) => (
							<SidebarMenuItem key={width}>
								<div className="flex h-8 items-center gap-2 rounded-md px-2">
									<Skeleton className="size-5 rounded-md" />
									<Skeleton className="h-4 flex-1" style={{ maxWidth: width }} />
								</div>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>
		</>
	);
}

function SidebarMainNavigation({
	pathname,
	showCloudFeatures,
	activeAgentId,
	activeAgentTile,
	activeAgentKind,
	agentsLoaded,
	activeSection,
	primaryProject,
	onNavigate,
}: {
	pathname: string;
	showCloudFeatures: boolean;
	activeAgentId: string | null;
	activeAgentTile: AgentTile | null;
	activeAgentKind: AgentChromeKind;
	agentsLoaded: boolean;
	activeSection: AgentSectionId;
	primaryProject?: AgentPrimaryProjectNavigation | null;
	onNavigate?: () => void;
}) {
	if (activeAgentId && activeAgentTile && activeAgentKind !== "unresolved") {
		return (
			<AgentFocusSections
				agentId={activeAgentId}
				kind={activeAgentKind}
				filesAvailable={activeAgentTile.filesAvailable}
				activeSection={activeSection}
				primaryProject={primaryProject}
				onNavigate={onNavigate}
			/>
		);
	}

	if (activeAgentId) {
		if (!agentsLoaded || activeAgentKind === "unresolved") {
			return (
				<AgentFocusLoadingSections
					agentId={activeAgentId}
					activeSection={activeSection}
					onNavigate={onNavigate}
				/>
			);
		}
		if (showCloudFeatures && agentsLoaded) {
			return (
				<AgentFocusHostedFallbackSections
					agentId={activeAgentId}
					activeSection={activeSection}
					onNavigate={onNavigate}
				/>
			);
		}
		return (
			<AgentFocusLoadingSections
				agentId={activeAgentId}
				activeSection={activeSection}
				onNavigate={onNavigate}
			/>
		);
	}

	return (
		<ConsoleNavigationSections
			pathname={pathname}
			showCloudFeatures={showCloudFeatures}
			onNavigate={onNavigate}
		/>
	);
}

type FocusNavigationPaneProps = {
	className?: string;
	pathname: string;
	showCloudFeatures: boolean;
	activeAgentId: string | null;
	activeAgent: SidebarEnvironment | null;
	activeAgentTile: AgentTile | null;
	activeAgentKind: AgentChromeKind;
	agentsLoaded: boolean;
	activeSection: AgentSectionId;
	primaryProject?: AgentPrimaryProjectNavigation | null;
	onNavigate?: () => void;
};

function FocusNavigationPane({
	className,
	pathname,
	showCloudFeatures,
	activeAgentId,
	activeAgent,
	activeAgentTile,
	activeAgentKind,
	agentsLoaded,
	activeSection,
	primaryProject,
	onNavigate,
}: FocusNavigationPaneProps) {
	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<SidebarHeader className="px-4 pt-3 pb-2">
				<FocusHeader
					activeAgent={activeAgent}
					activeAgentTile={activeAgentTile}
					activeAgentKind={activeAgentKind}
					activeAgentId={activeAgentId}
				/>
			</SidebarHeader>
			<SidebarContent className="pb-[calc(var(--header-height)+0.75rem)]">
				<SidebarMainNavigation
					pathname={pathname}
					showCloudFeatures={showCloudFeatures}
					activeAgentId={activeAgentId}
					activeAgentTile={activeAgentTile}
					activeAgentKind={activeAgentKind}
					agentsLoaded={agentsLoaded}
					activeSection={activeSection}
					primaryProject={primaryProject}
					onNavigate={onNavigate}
				/>
			</SidebarContent>
		</div>
	);
}

function RailFocusButton({
	render,
	label,
	caption,
	active,
	className,
	showTooltip = true,
	children,
}: {
	render: React.ReactElement;
	label: string;
	caption?: string;
	active: boolean;
	className?: string;
	showTooltip?: boolean;
	children: React.ReactNode;
}) {
	const hasCaption = Boolean(caption);
	const button = (
		<SidebarMenuButton
			render={render}
			size="lg"
			isActive={active}
			aria-label={label}
			className={cn(
				hasCaption
					? "h-[4.5rem] w-full flex-col justify-center gap-1 rounded-lg px-1 py-1"
					: "size-11 justify-center rounded-lg p-0",
				className,
			)}
		>
			{children}
			{caption ? (
				<span
					className={cn(
						"line-clamp-2 block h-[26px] max-w-16 overflow-hidden text-center text-2xs font-medium break-words",
						active ? "text-sidebar-accent-foreground" : "text-muted-foreground",
					)}
					title={label}
				>
					{caption}
				</span>
			) : null}
			<span className="sr-only">{label}</span>
		</SidebarMenuButton>
	);
	return (
		<div
			className={cn(
				"group/rail-focus relative flex min-w-0 items-center justify-center",
				hasCaption ? "h-[4.5rem] w-full" : "size-11",
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"absolute -left-2.5 w-1 rounded-r-full bg-sidebar-foreground/70 opacity-0 transition-[height,opacity] duration-200 ease-out",
					active
						? hasCaption
							? "h-11 opacity-100"
							: "h-8 opacity-100"
						: "h-2 group-hover/rail-focus:h-4 group-hover/rail-focus:opacity-50",
				)}
			/>
			{showTooltip ? (
				<Tooltip>
					<TooltipTrigger render={button} />
					<TooltipContent side="right" align="center">
						{label}
					</TooltipContent>
				</Tooltip>
			) : (
				button
			)}
		</div>
	);
}

function SortableAgentRailItem({
	agent,
	active,
	onNavigate,
	showTooltip,
}: {
	agent: AgentTile;
	active: boolean;
	onNavigate?: () => void;
	showTooltip: boolean;
}) {
	const router = useRouter();
	const {
		attributes,
		listeners,
		setActivatorNodeRef,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: agent.id,
		disabled: !agent.env,
	});
	const kind = agentTileChromeKind(agent);
	const identity = agent.env ?? {
		id: agent.id,
		name: agent.name,
		machine_name: agent.name,
		agent_type: agent.agentType,
	};
	const baseIdentityLabel =
		kind === "legacy"
			? `Legacy · ${agentTextLabel(identity, { includeSource: false, ownershipKind: kind })}`
			: agentTextLabel(identity, { includeSource: kind === "cloud", ownershipKind: kind });
	const label = kind === "cloud" ? agent.name : baseIdentityLabel;
	const caption = displayMachineName(agent.name);
	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition: isDragging ? undefined : transition,
		zIndex: isDragging ? 20 : undefined,
	};
	const activateAgent = () => {
		if (!agent.href) return;
		onNavigate?.();
		void router.navigate({ href: agent.href });
	};

	return (
		<SidebarMenuItem
			ref={setNodeRef}
			data-testid="app-sidebar-agent-tile"
			style={style}
			className={cn(
				"group/agent-rail-item relative h-[4.5rem] w-full touch-pan-y will-change-transform",
				isDragging && "opacity-80",
			)}
		>
			<RailFocusButton
				render={
					<button
						ref={setActivatorNodeRef}
						type="button"
						disabled={!agent.href}
						onClick={activateAgent}
						{...attributes}
						aria-disabled={agent.href ? undefined : true}
						aria-describedby={agent.env ? attributes["aria-describedby"] : undefined}
						aria-roledescription={agent.env ? attributes["aria-roledescription"] : undefined}
						{...listeners}
					/>
				}
				label={label}
				caption={caption}
				active={active}
				className={cn("touch-pan-y", agent.href && "cursor-pointer")}
				showTooltip={showTooltip}
			>
				<span className="relative inline-flex rounded-md">
					<AgentIcon agent={agent.agentType} size="rail" avatarUrl={agent.avatarUrl} />
					{kind === "cloud" ? (
						<span
							data-agent-rail-corner-marker="cloud"
							className="-top-1 -right-1 pointer-events-none absolute z-10"
						>
							<AgentSourceBadge source="hosted" iconOnly />
						</span>
					) : kind === "legacy" ? (
						<span
							data-agent-rail-corner-marker="legacy"
							className="-top-1 -right-1 pointer-events-none absolute z-10"
						>
							<LegacyAgentBadge iconOnly />
						</span>
					) : null}
				</span>
			</RailFocusButton>
		</SidebarMenuItem>
	);
}

function FocusRailContent({
	agents,
	activeAgentId,
	activeDeploymentSelector,
	onNavigate,
	showTooltips = true,
}: {
	agents: AgentTile[];
	activeAgentId: string | null;
	activeDeploymentSelector: string | null;
	onNavigate?: () => void;
	showTooltips?: boolean;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [railAgents, setRailAgents] = useState<AgentTile[]>(() =>
		[...agents].sort(compareAgentTiles),
	);
	const railAgentsRef = useRef(railAgents);
	const dragStartRailAgents = useRef<AgentTile[] | null>(null);
	const setRailAgentsOrder = (next: AgentTile[]) => {
		railAgentsRef.current = next;
		setRailAgents(next);
	};
	// Mouse and touch sensors keep scrolling distinct from drag activation. Enter
	// remains ordinary button activation; Space follows dnd-kit's screen-reader instructions.
	const sensors = useSensors(
		useSensor(MouseSensor, {
			activationConstraint: { distance: RAIL_DRAG_ACTIVATION_DISTANCE },
		}),
		useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
			keyboardCodes: RAIL_KEYBOARD_CODES,
		}),
	);
	useEffect(() => {
		if (!dragStartRailAgents.current) {
			setRailAgentsOrder([...agents].sort(compareAgentTiles));
		}
	}, [agents]);
	const orderedAgents = railAgents;
	const orderedAgentIds = orderedAgents.map((agent) => agent.id);
	const reorderAgents = useMutation({
		mutationFn: async ({
			environmentIds,
		}: {
			environmentIds: string[];
			previousRail: AgentTile[];
		}) => unwrap(await api.PATCH("/v1/agents/order", { body: { agent_ids: environmentIds } })),
		onMutate: async ({ environmentIds, previousRail }) => {
			await queryClient.cancelQueries({ queryKey: ["get", "/v1/agents"] });
			const previous = queryClient.getQueryData<SidebarEnvironment[]>(["get", "/v1/agents", {}]);
			queryClient.setQueryData<SidebarEnvironment[]>(["get", "/v1/agents", {}], (current) =>
				current ? reorderEnvironmentsForCache(current, environmentIds) : current,
			);
			return { previous, previousRail };
		},
		onError: (error, _variables, context) => {
			if (context?.previous) {
				queryClient.setQueryData(["get", "/v1/agents", {}], context.previous);
			}
			if (context?.previousRail) setRailAgentsOrder(context.previousRail);
			toast.error("Couldn't reorder agents", { description: errorMessage(error) });
		},
		onSuccess: (data) => {
			queryClient.setQueryData(["get", "/v1/agents", {}], data);
		},
	});
	const onDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		const initialAgents = dragStartRailAgents.current;
		dragStartRailAgents.current = null;
		if (!over) {
			if (initialAgents) setRailAgentsOrder(initialAgents);
			return;
		}
		let finalAgents = railAgentsRef.current;
		const initialIds = (initialAgents ?? orderedAgents).map((agent) => agent.id);
		let finalIds = finalAgents.map((agent) => agent.id);
		if (sameOrder(initialIds, finalIds) && active.id !== over.id) {
			const from = finalIds.indexOf(String(active.id));
			const to = finalIds.indexOf(String(over.id));
			if (from >= 0 && to >= 0) {
				finalAgents = reorderAgentTilesByIndex(finalAgents, from, to);
				setRailAgentsOrder(finalAgents);
				finalIds = finalAgents.map((agent) => agent.id);
			}
		}
		if (sameOrder(initialIds, finalIds)) return;
		reorderAgents.mutate({
			environmentIds: finalAgents.flatMap((agent) => (agent.env ? [agent.env.id] : [])),
			previousRail: initialAgents ?? orderedAgents,
		});
	};
	const onDragOver = (event: DragOverEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;
		const current = railAgentsRef.current;
		const activeId = String(active.id);
		const overId = String(over.id);
		const from = current.findIndex((agent) => agent.id === activeId);
		const to = current.findIndex((agent) => agent.id === overId);
		if (from < 0 || to < 0 || from === to) return;
		setRailAgentsOrder(reorderAgentTilesByIndex(current, from, to));
	};
	const beginRailDragGesture = () => {
		dragStartRailAgents.current = railAgentsRef.current;
	};

	return (
		<>
			<SidebarHeader className="h-(--clawdi-rail-width) items-center justify-center p-0">
				<SidebarMenu className="items-center">
					<SidebarMenuItem>
						<a
							href="https://clawdi.ai"
							target="_blank"
							rel="noopener noreferrer"
							aria-label="Open Clawdi homepage"
							className="flex size-11 items-center justify-center rounded-lg transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<img
								src="/clawdi-logo-transparent.png"
								alt=""
								className="size-9 shrink-0 rounded-md"
							/>
							<span className="sr-only">Clawdi</span>
						</a>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>

			<SidebarSeparator className="mx-auto w-8" />

			<SidebarContent className="items-center gap-2 overflow-x-hidden overflow-y-auto px-2.5 pt-2.5 pb-[calc(var(--header-height)+0.75rem)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				<SidebarMenu className="items-center">
					<SidebarMenuItem>
						<RailFocusButton
							render={<Link to="/" onClick={onNavigate} />}
							label="Console"
							caption="Console"
							active={!activeAgentId}
							showTooltip={showTooltips}
						>
							<IconChip size="sm" tint={RESOURCE_TINT_CLASSES.overview}>
								<LayoutDashboard />
							</IconChip>
						</RailFocusButton>
					</SidebarMenuItem>
				</SidebarMenu>

				<SidebarSeparator className="mx-auto w-8" />

				<SidebarMenu className="w-full items-center gap-1" data-testid="app-sidebar-agent-tiles">
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						modifiers={RAIL_DND_MODIFIERS}
						onDragStart={beginRailDragGesture}
						onDragCancel={() => {
							if (dragStartRailAgents.current) {
								setRailAgentsOrder(dragStartRailAgents.current);
							} else {
								setRailAgentsOrder([...agents].sort(compareAgentTiles));
							}
							dragStartRailAgents.current = null;
						}}
						onDragOver={onDragOver}
						onDragEnd={onDragEnd}
					>
						<SortableContext items={orderedAgentIds} strategy={verticalListSortingStrategy}>
							{orderedAgents.map((agent) => (
								<SortableAgentRailItem
									key={agent.id}
									agent={agent}
									active={Boolean(
										activeAgentId &&
											agentTileMatchesRouteId(agent, activeAgentId, activeDeploymentSelector),
									)}
									onNavigate={onNavigate}
									showTooltip={showTooltips}
								/>
							))}
						</SortableContext>
					</DndContext>
					<NewAgentButton compact showTooltip={showTooltips} onNavigate={onNavigate} />
				</SidebarMenu>
			</SidebarContent>
		</>
	);
}

function agentVersionLabel(version: string | null | undefined): string | null {
	const trimmed = version?.trim();
	if (!trimmed) return null;
	return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function agentHeaderMeta(
	agent: SidebarEnvironment,
	kind: AgentChromeKind,
): {
	visibleLabel: string;
	detailLabel: string;
	activityLabel: string;
} {
	const sourceDetail =
		kind === "cloud" ? agentSourceKindLabel("hosted") : kind === "legacy" ? "Legacy" : null;
	// Legacy v1 agents run in a hosted runtime image too, so both hosted
	// kinds get the "runtime" suffix.
	const runtime = kind === "legacy";
	const typeLabel = agentTypeLabel(agent.agent_type);
	const version = agentVersionLabel(agent.agent_version);
	const relativeSeen = agent.last_seen_at ? relativeTime(agent.last_seen_at) : null;
	const activityLabel = relativeSeen ? `last seen ${relativeSeen}` : "never seen";
	const visible = [runtime ? `${typeLabel} runtime` : typeLabel, agent.os?.trim() || null].filter(
		(item): item is string => Boolean(item),
	);
	const detail = [
		sourceDetail,
		runtime ? `${typeLabel} runtime` : typeLabel,
		version,
		agent.os?.trim() || null,
	].filter((item): item is string => Boolean(item));
	return { visibleLabel: visible.join(" · "), detailLabel: detail.join(" · "), activityLabel };
}

export function focusHeaderSyncSource(
	kind: AgentChromeKind,
	hasEnvironment: boolean,
): DaemonStatusSource | null {
	if (!hasEnvironment || kind === "unresolved") return null;
	if (kind === "cloud") return null;
	return kind === "connected" ? "self-managed" : "on-clawdi";
}

export function focusHeaderComputeStatus(
	kind: AgentChromeKind,
	tile: AgentTile | null,
): AgentCardStatusProjection["visual"] | null {
	return kind === "cloud" ? (tile?.cardStatus?.visual ?? null) : null;
}

const FOCUS_HEADER_STATUS_CLASS = "mt-2 flex min-w-0 items-center gap-2 text-xs leading-4";

function FocusHeader({
	activeAgent,
	activeAgentTile,
	activeAgentKind,
	activeAgentId,
}: {
	activeAgent: SidebarEnvironment | null;
	activeAgentTile: AgentTile | null;
	activeAgentKind: AgentChromeKind;
	activeAgentId: string | null;
}) {
	if (!activeAgent && !activeAgentId) {
		return (
			<div className="min-w-0">
				<div className="truncate text-sm font-semibold leading-5">Console</div>
				<div className="truncate text-xs leading-4 text-muted-foreground">
					Account resources and agents
				</div>
			</div>
		);
	}

	if (activeAgentKind === "unresolved") {
		return (
			<div className="min-w-0 space-y-2" role="status" aria-label="Agent ownership loading">
				<Skeleton className="h-4 w-32" />
				<Skeleton className="h-3 w-24" />
				<Skeleton className="h-4 w-20" />
			</div>
		);
	}

	if (!activeAgent && !activeAgentTile) {
		return (
			<div className="min-w-0">
				<div className="truncate text-sm font-semibold leading-5">Agent not found</div>
				<div className="truncate text-xs leading-4 text-muted-foreground">
					No details are available
				</div>
			</div>
		);
	}

	const name =
		activeAgentTile?.name ?? (activeAgent ? agentDisplayName(activeAgent) : "Clawdi Cloud agent");
	const displayName = displayMachineName(name);
	const meta = activeAgent ? agentHeaderMeta(activeAgent, activeAgentKind) : null;
	const activityLabel =
		activeAgentKind === "cloud" ? null : (meta?.activityLabel ?? "Agent details unavailable");
	const visibleLabel = meta?.visibleLabel;
	const detailLabel = meta?.detailLabel;
	const title = [name, detailLabel, activityLabel].filter(Boolean).join(" · ");
	const manageHref =
		activeAgentKind === "legacy" ? (legacyHostedDashboardUrl() ?? undefined) : undefined;
	const syncSource = focusHeaderSyncSource(activeAgentKind, Boolean(activeAgent));
	const computeStatus = focusHeaderComputeStatus(activeAgentKind, activeAgentTile);
	return (
		<div className="min-w-0 text-left">
			<div className="flex min-w-0 items-center gap-2" title={title}>
				<span className="truncate text-sm font-semibold leading-5">{displayName}</span>
				{activeAgentKind === "cloud" ? (
					activeAgent ? (
						<AgentSourceBadgeForEnvironment
							env={activeAgent}
							ownershipKind={activeAgentKind}
							compact
						/>
					) : (
						<AgentSourceBadge source="hosted" compact />
					)
				) : activeAgentKind === "legacy" ? (
					<LegacyAgentBadge compact />
				) : null}
			</div>
			{visibleLabel ? (
				<div className="mt-1 truncate text-xs leading-4 text-muted-foreground" title={detailLabel}>
					{visibleLabel}
				</div>
			) : null}
			{computeStatus ? (
				<div
					data-testid="app-sidebar-agent-status"
					data-agent-status-source="hosted"
					className={FOCUS_HEADER_STATUS_CLASS}
					title={computeStatus.tooltip}
				>
					<StatusDot className={computeStatus.dotClass} />
					<span className="truncate font-medium">{computeStatus.label}</span>
				</div>
			) : activeAgent && syncSource ? (
				<div
					data-testid="app-sidebar-agent-status"
					data-agent-status-source="connected"
					className={cn(FOCUS_HEADER_STATUS_CLASS, "justify-between")}
				>
					{/* Cloud and legacy agents use supervised-runtime copy. Legacy
					 * remediation stays in v1 when that dashboard is configured. */}
					<DaemonStatusBadge
						env={activeAgent}
						source={syncSource}
						manageHref={manageHref}
						compact
						tooltipDetail={detailLabel}
					/>
					<span
						className="min-w-0 truncate text-muted-foreground"
						title={activityLabel ?? undefined}
					>
						{activityLabel}
					</span>
				</div>
			) : activeAgentKind !== "cloud" ? (
				<div
					data-testid="app-sidebar-agent-status"
					data-agent-status-source="fallback"
					className={FOCUS_HEADER_STATUS_CLASS}
				>
					<FocusStatusFallback />
				</div>
			) : null}
		</div>
	);
}

function FocusStatusFallback() {
	return (
		<span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
			<StatusDot className="border border-muted-foreground/50 bg-transparent" />
			<span>Status</span>
		</span>
	);
}

function RailSidebar({
	agents,
	activeAgentId,
	activeDeploymentSelector,
}: {
	agents: AgentTile[];
	activeAgentId: string | null;
	activeDeploymentSelector: string | null;
}) {
	return (
		<Sidebar
			collapsible="none"
			style={{ "--sidebar-width": "var(--clawdi-rail-width)" } as React.CSSProperties}
			className="sticky top-0 hidden h-svh shrink-0 border-r bg-sidebar/95 md:flex"
			aria-label="Focus rail"
			data-testid="app-sidebar-agent-rail"
		>
			<FocusRailContent
				agents={agents}
				activeAgentId={activeAgentId}
				activeDeploymentSelector={activeDeploymentSelector}
			/>
		</Sidebar>
	);
}

function GitHubIcon({ className, ...props }: React.ComponentProps<"svg">) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
			className={className}
			{...props}
		>
			<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.757-1.333-1.757-1.09-.745.083-.729.083-.729 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.997.108-.775.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.468-2.382 1.235-3.222-.123-.303-.535-1.523.118-3.176 0 0 1.008-.322 3.3 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.29-1.552 3.296-1.23 3.296-1.23.655 1.653.243 2.873.12 3.176.77.84 1.233 1.912 1.233 3.222 0 4.61-2.805 5.625-5.475 5.922.43.372.823 1.103.823 2.222 0 1.605-.015 2.898-.015 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
		</svg>
	);
}

function HelpMenuItems() {
	return (
		<DropdownMenuGroup>
			<DropdownMenuItem
				render={
					<a
						href="https://deepwiki.com/Clawdi-AI/clawdi"
						target="_blank"
						rel="noopener noreferrer"
						aria-label="Open Docs"
					/>
				}
			>
				<BookOpen />
				Docs
				<ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
			</DropdownMenuItem>
			<DropdownMenuItem
				render={
					<a
						href="https://github.com/Clawdi-AI/clawdi"
						target="_blank"
						rel="noopener noreferrer"
						aria-label="Open GitHub"
					/>
				}
			>
				<GitHubIcon />
				GitHub
				<ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
			</DropdownMenuItem>
			<DropdownMenuItem render={<a href="mailto:support@clawdi.ai" aria-label="Email support" />}>
				<Mail />
				support@clawdi.ai
			</DropdownMenuItem>
			<DropdownMenuItem
				render={
					<a
						href="https://t.me/clawdiofficial"
						target="_blank"
						rel="noopener noreferrer"
						aria-label="Open Telegram"
					/>
				}
			>
				<MessageCircle />
				Telegram @clawdiofficial
			</DropdownMenuItem>
		</DropdownMenuGroup>
	);
}

function GlobalControlButton({
	label,
	children,
	onClick,
	active = false,
	tooltipSide = "top",
	showTooltip = true,
}: {
	label: string;
	children: React.ReactNode;
	onClick?: () => void;
	active?: boolean;
	tooltipSide?: "right" | "top";
	showTooltip?: boolean;
}) {
	const button = (
		<Button
			type="button"
			variant={active ? "secondary" : "ghost"}
			size="icon-lg"
			onClick={onClick}
			aria-label={label}
			aria-pressed={active}
			data-testid={`app-sidebar-${label.toLowerCase()}-button`}
			className={cn("rounded-lg", active && "ring-2 ring-ring/40")}
		>
			{children}
		</Button>
	);
	if (!showTooltip) return button;
	return (
		<Tooltip>
			<TooltipTrigger render={button} />
			<TooltipContent side={tooltipSide}>{label}</TooltipContent>
		</Tooltip>
	);
}

function HelpControl({ showTooltip = true }: { showTooltip?: boolean }) {
	const trigger = (
		<DropdownMenuTrigger
			render={
				<Button
					type="button"
					variant="ghost"
					size="icon-lg"
					aria-label="Help"
					data-testid="app-sidebar-help-menu-button"
					className="rounded-lg"
				/>
			}
		>
			<CircleHelp />
		</DropdownMenuTrigger>
	);
	return (
		<DropdownMenu>
			{showTooltip ? (
				<Tooltip>
					<TooltipTrigger render={trigger} />
					<TooltipContent side="top">Help</TooltipContent>
				</Tooltip>
			) : (
				trigger
			)}
			<DropdownMenuContent side="top" align="start" className="min-w-56">
				<HelpMenuItems />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function UserControl({
	user,
	showTooltip = true,
}: {
	user: ReturnType<typeof useCurrentUser>["user"];
	showTooltip?: boolean;
}) {
	const initial = user?.fullName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "U";
	const trigger = (
		<DropdownMenuTrigger
			render={
				<Button
					type="button"
					variant="ghost"
					size="icon-lg"
					className="rounded-lg"
					aria-label="User menu"
					data-testid="app-sidebar-user-menu-button"
				/>
			}
		>
			<Avatar className="size-8 rounded-md">
				{user?.imageUrl ? <AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} /> : null}
				<AvatarFallback className="rounded-md">{initial}</AvatarFallback>
			</Avatar>
		</DropdownMenuTrigger>
	);
	return (
		<DropdownMenu>
			{showTooltip ? (
				<Tooltip>
					<TooltipTrigger render={trigger} />
					<TooltipContent side="top">User menu</TooltipContent>
				</Tooltip>
			) : (
				trigger
			)}
			<DropdownMenuContent className="min-w-56 rounded-lg" side="top" align="start">
				<UserMenuItems />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function GlobalControls({
	user,
	onSearch,
	onSettings,
	settingsOpen,
	showTooltips = true,
}: {
	user: ReturnType<typeof useCurrentUser>["user"];
	onSearch: () => void;
	onSettings: () => void;
	settingsOpen: boolean;
	showTooltips?: boolean;
}) {
	const settingsIdentity = CANONICAL_NAVIGATION_IDENTITIES.settings;
	const SettingsIcon = settingsIdentity.icon;
	return (
		<SidebarMenu className="w-full flex-row items-center gap-1">
			<SidebarMenuItem>
				<UserControl user={user} showTooltip={showTooltips} />
			</SidebarMenuItem>
			<SidebarMenuItem className="ml-auto">
				<GlobalControlButton label="Search" onClick={onSearch} showTooltip={showTooltips}>
					<Search />
				</GlobalControlButton>
			</SidebarMenuItem>
			<SidebarMenuItem>
				<HelpControl showTooltip={showTooltips} />
			</SidebarMenuItem>
			<SidebarMenuItem>
				<GlobalControlButton
					label={settingsIdentity.label}
					onClick={onSettings}
					active={settingsOpen}
					showTooltip={showTooltips}
				>
					<SettingsIcon />
				</GlobalControlButton>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}

function SidebarGlobalControlsBar({
	user,
	onSearch,
	onSettings,
	settingsOpen,
	showTooltips = true,
	mobile = false,
	collapsed = false,
}: {
	user: ReturnType<typeof useCurrentUser>["user"];
	onSearch: () => void;
	onSettings: () => void;
	settingsOpen: boolean;
	showTooltips?: boolean;
	mobile?: boolean;
	collapsed?: boolean;
}) {
	if (!mobile && collapsed) return null;
	return (
		<div
			data-sidebar="global-controls"
			data-testid="app-sidebar-global-controls"
			className={cn(
				"z-30 h-(--header-height) items-center border-border border-t bg-sidebar px-3 text-sidebar-foreground",
				mobile
					? "absolute inset-x-0 bottom-0 flex"
					: "fixed bottom-0 left-0 hidden w-[calc(var(--clawdi-rail-width)+var(--sidebar-width))] md:flex",
			)}
		>
			<GlobalControls
				user={user}
				onSearch={onSearch}
				onSettings={onSettings}
				settingsOpen={settingsOpen}
				showTooltips={showTooltips}
			/>
		</div>
	);
}

export function AppSidebar({
	className,
	variant,
	style,
	...props
}: React.ComponentProps<typeof Sidebar>) {
	const router = useRouter();
	const pathname = useLocation({ select: (location) => location.pathname });
	const routeSearch = useSearch({ from: "/_protected/_dashboard" });
	const { user } = useCurrentUser();
	const { setOpen: setPaletteOpen } = useCommandPalette();
	const { isMobile, setOpenMobile, state: sidebarState } = useSidebar();
	const $api = useOpenApi();
	const hostedAccess = useHostedProductAccess();
	const hydrated = useHydrated();
	const [hostedAgentTiles, setHostedAgentTiles] = useState<AgentTile[] | null>(null);
	const [hostedMembershipResolved, setHostedMembershipResolved] = useState(false);
	const [hostedInventoryFetching, setHostedInventoryFetching] = useState(false);
	const updateHostedAgentList = useCallback(
		(tiles: AgentTile[] | null, membershipResolved: boolean, inventoryFetching: boolean) => {
			setHostedAgentTiles(tiles);
			setHostedMembershipResolved(membershipResolved);
			setHostedInventoryFetching(inventoryFetching);
		},
		[],
	);
	const showCloudFeatures = hydrated && IS_HOSTED && hostedAccess.canCreateCloudAgents;
	const agentRoute = parseAgentPathname(pathname);
	const activeAgentId = agentRoute?.agentId ?? null;
	const activeDeploymentSelector = agentRoute ? agentDeploymentSelector(routeSearch) : null;
	const { data: environments } = $api.useQuery(
		"get",
		"/v1/agents",
		{},
		{
			refetchInterval: activeAgentId ? 10_000 : false,
			refetchIntervalInBackground: false,
		},
	);
	const hydratedEnvironments = hydrated ? environments : undefined;
	const selfManagedTiles = useMemo(
		() => selfManagedAgentTiles(hydratedEnvironments),
		[hydratedEnvironments],
	);
	const unifiedAgentListEnabled = hydrated && Boolean(HostedUnifiedAgentListSensor);
	const agentsLoaded = unifiedAgentListEnabled
		? hostedAgentTiles !== null && hostedMembershipResolved
		: hydratedEnvironments !== undefined;
	const agents = unifiedAgentListEnabled ? (hostedAgentTiles ?? []) : selfManagedTiles;
	const activeAgentTile = activeAgentId
		? (agents.find((tile) =>
				agentTileMatchesRouteId(tile, activeAgentId, activeDeploymentSelector),
			) ?? null)
		: null;
	const activeAgent = activeAgentId
		? (hydratedEnvironments?.find((env) => env.id === activeAgentId) ?? null)
		: null;
	const defaultProjectBindings = useAgentProjectBindings(activeAgent?.id, {
		enabled: hydrated && Boolean(activeAgent?.default_project_id),
	});
	const navigableProjects = $api.useQuery(
		"get",
		"/v1/projects",
		{},
		{ enabled: hydrated && Boolean(activeAgent?.default_project_id) },
	);
	const resolvedPrimaryProject =
		defaultProjectBindings.isLoading ||
		defaultProjectBindings.error ||
		navigableProjects.isLoading ||
		navigableProjects.error
			? null
			: resolveAgentDefaultProject(
					defaultProjectBindings.data ?? [],
					navigableProjects.data ?? [],
					activeAgent?.default_project_id,
				);
	const primaryProject = resolvedPrimaryProject
		? {
				id: resolvedPrimaryProject.id,
				contextProjectIds: (defaultProjectBindings.data ?? [])
					.filter((binding) => binding.binding_type === "context")
					.map((binding) => binding.project_id),
			}
		: null;
	const classifiedActiveAgentKind = useAgentChromeKind(activeAgent, activeAgentTile);
	const activeAgentKind =
		activeAgentTile || !activeAgentId || (agentsLoaded && !hostedInventoryFetching)
			? classifiedActiveAgentKind
			: "unresolved";
	const activeSection = agentRoute?.section ?? "overview";
	const settingsSection = routeSearch.settings ?? null;
	const settingsOpen = settingsSection !== null;
	const activeSettingsSection = settingsSection ?? DEFAULT_SETTINGS_SECTION;
	const setSettingsSection = (section: SettingsSectionId | null) =>
		router.navigate({
			to: ".",
			search: (current) => ({ ...current, settings: section ?? undefined }),
			hash: true,
			replace: true,
			resetScroll: false,
		});
	const openSettings = () => {
		void setSettingsSection(settingsSection ?? DEFAULT_SETTINGS_SECTION);
	};
	const changeSettingsSection = (section: SettingsSectionId) => {
		void setSettingsSection(section);
	};
	const setSettingsOpen = (nextOpen: boolean) => {
		if (nextOpen) {
			openSettings();
			return;
		}
		void setSettingsSection(null);
	};
	const closeMobileSidebar = () => setOpenMobile(false);
	const openSearch = () => {
		closeMobileSidebar();
		setPaletteOpen(true);
	};
	const openSettingsFromSidebar = () => {
		closeMobileSidebar();
		openSettings();
	};

	return (
		<>
			{unifiedAgentListEnabled && HostedUnifiedAgentListSensor ? (
				<Suspense fallback={null}>
					<HostedUnifiedAgentListSensor
						cloudEnvs={hydratedEnvironments ?? EMPTY_SIDEBAR_ENVIRONMENTS}
						showCloudDeployments
						showLegacyAgents={hostedAccess.canUseLegacyHostedDashboard}
						onChange={updateHostedAgentList}
					/>
				</Suspense>
			) : null}
			{!isMobile ? (
				<RailSidebar
					agents={agents}
					activeAgentId={activeAgentId}
					activeDeploymentSelector={activeDeploymentSelector}
				/>
			) : null}
			<Sidebar
				collapsible="offcanvas"
				variant={variant}
				data-testid="app-sidebar"
				style={
					{
						...style,
						"--sidebar-left-offset": "var(--clawdi-rail-width)",
					} as React.CSSProperties
				}
				className={cn(
					"data-[side=left]:left-[var(--clawdi-rail-width)] data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--clawdi-rail-width)-var(--sidebar-width))]",
					className,
				)}
				{...props}
			>
				{!isMobile ? (
					<FocusNavigationPane
						pathname={pathname}
						showCloudFeatures={showCloudFeatures}
						activeAgentId={activeAgentId}
						activeAgent={activeAgent ?? null}
						activeAgentTile={activeAgentTile}
						activeAgentKind={activeAgentKind}
						agentsLoaded={agentsLoaded}
						activeSection={activeSection}
						primaryProject={primaryProject}
					/>
				) : null}

				{isMobile ? (
					<div
						className="relative flex min-h-0 flex-1"
						style={
							{
								"--clawdi-rail-width": "calc(var(--spacing) * 20)",
								"--header-height": "calc(var(--spacing) * 12)",
							} as React.CSSProperties
						}
					>
						<nav
							className="flex w-(--clawdi-rail-width) shrink-0 flex-col border-r bg-sidebar/95"
							aria-label="Focus rail"
						>
							<FocusRailContent
								agents={agents}
								activeAgentId={activeAgentId}
								activeDeploymentSelector={activeDeploymentSelector}
								onNavigate={closeMobileSidebar}
								showTooltips={false}
							/>
						</nav>
						<FocusNavigationPane
							className="min-w-0"
							pathname={pathname}
							showCloudFeatures={showCloudFeatures}
							activeAgentId={activeAgentId}
							activeAgent={activeAgent ?? null}
							activeAgentTile={activeAgentTile}
							activeAgentKind={activeAgentKind}
							agentsLoaded={agentsLoaded}
							activeSection={activeSection}
							primaryProject={primaryProject}
							onNavigate={closeMobileSidebar}
						/>
						<SidebarGlobalControlsBar
							user={user}
							onSearch={openSearch}
							onSettings={openSettingsFromSidebar}
							settingsOpen={settingsOpen}
							showTooltips={false}
							mobile
						/>
					</div>
				) : null}
			</Sidebar>
			{!isMobile ? (
				<SidebarGlobalControlsBar
					user={user}
					onSearch={openSearch}
					onSettings={openSettingsFromSidebar}
					settingsOpen={settingsOpen}
					collapsed={sidebarState === "collapsed"}
				/>
			) : null}
			<SettingsDialog
				open={settingsOpen}
				section={activeSettingsSection}
				agentTiles={agents}
				hasExistingCloudAgents={
					hostedAgentTiles?.some((tile) => tile.source === "on-clawdi") ?? false
				}
				cloudInventoryResolved={agentsLoaded && !hostedInventoryFetching}
				onSectionChange={changeSettingsSection}
				onOpenChange={setSettingsOpen}
			/>
		</>
	);
}
