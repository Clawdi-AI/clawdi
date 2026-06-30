"use client";

import type { components } from "@clawdi/shared/api";
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	type Modifier,
	PointerSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import {
	BookOpen,
	CircleHelp,
	Cloud,
	ExternalLink,
	Layers,
	LayoutDashboard,
	Link2,
	type LucideIcon,
	Mail,
	MessageCircle,
	MessageSquare,
	MessagesSquare,
	MonitorPlay,
	Search,
	Settings,
	Sparkles,
	TerminalSquare,
	Zap,
} from "lucide-react";
import { useQueryState } from "nuqs";
import { parseAsStringLiteral } from "nuqs/server";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useCommandPalette } from "@/components/command-palette";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import {
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
	agentSourceKindLabel,
	agentTextLabel,
	agentTypeLabel,
	compareAgentEnvironments,
	displayMachineName,
	isHostedAgentEnvironment,
} from "@/components/dashboard/agent-label";
import { DaemonStatusBadge } from "@/components/dashboard/daemon-status";
import { NewAgentButton } from "@/components/dashboard/new-agent-button";
import { PROJECT_RESOURCE_ICONS } from "@/components/project-resource-icons";
import { SettingsDialog } from "@/components/settings-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserMenuItems } from "@/components/user-menu";
import {
	type AgentSectionId,
	agentSectionHref,
	agentSectionLabel,
	parseAgentPathname,
} from "@/lib/agent-routes";
import { unwrap, useApi } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-client";
import { IS_HOSTED } from "@/lib/hosted";
import {
	PROJECT_RESOURCE_GROUPS,
	projectResourceDefinitionsForGroup,
	projectResourceScopeLabel,
} from "@/lib/project-resource-model";
import { RESOURCE_TINT_CLASSES } from "@/lib/resource-identity";
import {
	DEFAULT_SETTINGS_SECTION,
	SETTINGS_QUERY_KEY,
	SETTINGS_SECTION_IDS,
	type SettingsSectionId,
} from "@/lib/settings-routes";
import { cn, errorMessage, relativeTime } from "@/lib/utils";
import { useV2Access } from "@/lib/v2-access";

/** Tinted chip around a nav icon — the identity-palette hue carries the
 * "vivid, colourful" art direction into the app chrome itself, and each
 * resource keeps the same hue here, in the overview Resources rail, and
 * on its own pages. The chip (not the glyph) is colored so icons stay
 * one visual weight. */
function NavIconChip({ tint, children }: { tint: string; children: React.ReactNode }) {
	return (
		<span
			className={cn(
				"flex size-5 shrink-0 items-center justify-center rounded-md [&>svg]:size-3.5",
				tint,
			)}
		>
			{children}
		</span>
	);
}

function RailIconChip({ tint, children }: { tint: string; children: React.ReactNode }) {
	return (
		<span
			className={cn(
				"flex size-8 shrink-0 items-center justify-center rounded-md [&>svg]:size-4",
				tint,
			)}
		>
			{children}
		</span>
	);
}

const CONNECTED_AGENT_SECTIONS: {
	id: AgentSectionId;
	icon: LucideIcon;
	tooltip: string;
}[] = [
	{
		id: "overview",
		icon: LayoutDashboard,
		tooltip: "Agent overview",
	},
	{
		id: "sessions",
		icon: MessageSquare,
		tooltip: "Sessions from this agent",
	},
	{
		id: "skills",
		icon: Sparkles,
		tooltip: "Skills installed in this agent's Agent Project",
	},
	{
		id: "projects",
		icon: Layers,
		tooltip: "Agent Project and added Projects",
	},
	{
		id: "settings",
		icon: Settings,
		tooltip: "Name and avatar for this agent",
	},
];

const HOSTED_AGENT_SECTIONS: {
	id: AgentSectionId;
	icon: LucideIcon;
	tooltip: string;
}[] = [
	{
		id: "overview",
		icon: LayoutDashboard,
		tooltip: "Runtime overview",
	},
	{
		id: "console",
		icon: MonitorPlay,
		tooltip: "Open the hosted runtime Control UI",
	},
	{
		id: "terminal",
		icon: TerminalSquare,
		tooltip: "Open a hosted shell",
	},
	{
		id: "sessions",
		icon: MessageSquare,
		tooltip: "Sessions from this runtime",
	},
	{
		id: "ai",
		icon: Zap,
		tooltip: "Runtime model provider binding",
	},
	{
		id: "channels",
		icon: Link2,
		tooltip: "Channels linked to this runtime",
	},
	{
		id: "settings",
		icon: Settings,
		tooltip: "Profile, compute, and lifecycle",
	},
];

const AGENT_SECTION_TINTS = {
	overview: RESOURCE_TINT_CLASSES.overview,
	sessions: RESOURCE_TINT_CLASSES.sessions,
	skills: RESOURCE_TINT_CLASSES.skills,
	projects: RESOURCE_TINT_CLASSES.projects,
	console: "bg-identity-6-bg text-identity-6-fg",
	terminal: "bg-identity-7-bg text-identity-7-fg",
	ai: "bg-identity-2-bg text-identity-2-fg",
	channels: "bg-identity-5-bg text-identity-5-fg",
	settings: "bg-identity-4-bg text-identity-4-fg",
} satisfies Record<AgentSectionId, string>;

type SidebarEnvironment = components["schemas"]["EnvironmentResponse"];

type SidebarNavItem = {
	id: string;
	label: string;
	href: string;
	icon: LucideIcon;
	tint: string;
	tooltip: string;
	active: boolean;
};

type AgentSectionDefinition = {
	id: AgentSectionId;
	icon: LucideIcon;
	tooltip: string;
};

const RAIL_DRAG_ACTIVATION_DISTANCE = 10;

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

function reorderEnvironmentsByIndex(
	current: SidebarEnvironment[],
	from: number,
	to: number,
): SidebarEnvironment[] {
	return arrayMove(current, from, to).map((env, index) => ({ ...env, sort_order: index }));
}

function sameOrder(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

function SidebarNavSection({
	label,
	items,
	before,
	onNavigate,
}: {
	label: string;
	items: SidebarNavItem[];
	before?: React.ReactNode;
	onNavigate?: () => void;
}) {
	return (
		<SidebarGroup className="pt-0">
			<SidebarGroupLabel>{label}</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu>
					{before}
					{items.map((item) => {
						const Icon = item.icon;
						return (
							<SidebarMenuItem key={item.id}>
								<SidebarMenuButton asChild isActive={item.active} tooltip={item.tooltip}>
									<Link to={item.href} onClick={onNavigate}>
										<NavIconChip tint={item.tint}>
											<Icon />
										</NavIconChip>
										<span>{item.label}</span>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>
						);
					})}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	);
}

function ConsolePrimarySection({
	pathname,
	onNavigate,
}: {
	pathname: string;
	onNavigate?: () => void;
}) {
	const items: SidebarNavItem[] = [
		{
			id: "overview",
			label: "Overview",
			href: "/",
			icon: LayoutDashboard,
			tint: RESOURCE_TINT_CLASSES.overview,
			tooltip: "Console overview",
			active: pathname === "/",
		},
		{
			id: "agents",
			label: "Agents",
			href: "/agents",
			icon: MonitorPlay,
			tint: "bg-identity-6-bg text-identity-6-fg",
			tooltip: "All agents",
			active: pathname === "/agents",
		},
	];

	return <SidebarNavSection label="Primary" items={items} onNavigate={onNavigate} />;
}

function ConsoleResourcesSection({
	pathname,
	showV2Features,
	onNavigate,
}: {
	pathname: string;
	showV2Features: boolean;
	onNavigate?: () => void;
}) {
	const resourceItems: SidebarNavItem[] = PROJECT_RESOURCE_GROUPS.flatMap((group) =>
		projectResourceDefinitionsForGroup(group.id).map((definition) => {
			const Icon = PROJECT_RESOURCE_ICONS[definition.id];
			return {
				id: definition.id,
				label: definition.navLabel,
				href: definition.href,
				icon: Icon,
				tint: RESOURCE_TINT_CLASSES[definition.id],
				tooltip: `${definition.navLabel} - ${projectResourceScopeLabel(definition.projectScope)}`,
				active: pathname === definition.href || pathname.startsWith(`${definition.href}/`),
			};
		}),
	);

	if (showV2Features) {
		resourceItems.push(
			{
				id: "channels",
				label: "Channels",
				href: "/channels",
				icon: MessagesSquare,
				tint: "bg-identity-5-bg text-identity-5-fg",
				tooltip: "Channels - Account resources",
				active: pathname === "/channels" || pathname.startsWith("/channels/"),
			},
			{
				id: "model-providers",
				label: "Model Providers",
				href: "/ai-providers",
				icon: Sparkles,
				tint: "bg-identity-2-bg text-identity-2-fg",
				tooltip: "Model Providers - Account resources",
				active: pathname === "/ai-providers" || pathname.startsWith("/ai-providers/"),
			},
		);
	}

	return <SidebarNavSection label="Resources" items={resourceItems} onNavigate={onNavigate} />;
}

function AgentSectionList({
	agentId,
	sections,
	activeSection,
	onNavigate,
}: {
	agentId: string;
	sections: readonly AgentSectionDefinition[];
	activeSection: AgentSectionId;
	onNavigate?: () => void;
}) {
	const normalizedActiveSection = sections.some((section) => section.id === activeSection)
		? activeSection
		: "overview";
	const primarySections = sections.filter(
		(section) => section.id === "overview" || section.id === "console" || section.id === "terminal",
	);
	const resourceSections = sections.filter(
		(section) => section.id !== "overview" && section.id !== "console" && section.id !== "terminal",
	);

	const primaryItems = primarySections.map((section): SidebarNavItem => {
		const Icon = section.icon;
		return {
			id: section.id,
			label: agentSectionLabel(section.id),
			href: agentSectionHref(agentId, section.id),
			icon: Icon,
			tint: AGENT_SECTION_TINTS[section.id],
			tooltip: section.tooltip,
			active: normalizedActiveSection === section.id,
		};
	});
	const resourceItems = resourceSections.map((section): SidebarNavItem => {
		const Icon = section.icon;
		return {
			id: section.id,
			label: agentSectionLabel(section.id),
			href: agentSectionHref(agentId, section.id),
			icon: Icon,
			tint: AGENT_SECTION_TINTS[section.id],
			tooltip: section.tooltip,
			active: normalizedActiveSection === section.id,
		};
	});

	return (
		<>
			<SidebarNavSection label="Primary" items={primaryItems} onNavigate={onNavigate} />
			<SidebarNavSection label="Resources" items={resourceItems} onNavigate={onNavigate} />
		</>
	);
}

function AgentFocusSections({
	agent,
	activeSection,
	showV2Features,
	onNavigate,
}: {
	agent: SidebarEnvironment;
	activeSection: AgentSectionId;
	showV2Features: boolean;
	onNavigate?: () => void;
}) {
	const hosted = showV2Features && isHostedAgentEnvironment(agent);
	return (
		<AgentSectionList
			agentId={agent.id}
			sections={hosted ? HOSTED_AGENT_SECTIONS : CONNECTED_AGENT_SECTIONS}
			activeSection={activeSection}
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
			sections={HOSTED_AGENT_SECTIONS}
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
	const overviewItem: SidebarNavItem = {
		id: "overview",
		label: "Overview",
		href: agentSectionHref(agentId),
		icon: LayoutDashboard,
		tint: RESOURCE_TINT_CLASSES.overview,
		tooltip: "Agent overview",
		active: activeSection === "overview",
	};

	return (
		<>
			<SidebarNavSection label="Primary" items={[overviewItem]} onNavigate={onNavigate} />
			<SidebarGroup className="pt-0">
				<SidebarGroupLabel>Resources</SidebarGroupLabel>
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
	showV2Features,
	activeAgentId,
	activeAgent,
	agentsLoaded,
	activeSection,
	onNavigate,
}: {
	pathname: string;
	showV2Features: boolean;
	activeAgentId: string | null;
	activeAgent: SidebarEnvironment | null;
	agentsLoaded: boolean;
	activeSection: AgentSectionId;
	onNavigate?: () => void;
}) {
	if (activeAgent) {
		return (
			<AgentFocusSections
				agent={activeAgent}
				activeSection={activeSection}
				showV2Features={showV2Features}
				onNavigate={onNavigate}
			/>
		);
	}

	if (activeAgentId) {
		if (showV2Features && agentsLoaded) {
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
		<>
			<ConsolePrimarySection pathname={pathname} onNavigate={onNavigate} />
			<ConsoleResourcesSection
				pathname={pathname}
				showV2Features={showV2Features}
				onNavigate={onNavigate}
			/>
		</>
	);
}

type FocusNavigationPaneProps = {
	className?: string;
	pathname: string;
	showV2Features: boolean;
	activeAgentId: string | null;
	activeAgent: SidebarEnvironment | null;
	agentsLoaded: boolean;
	activeSection: AgentSectionId;
	onNavigate?: () => void;
};

function FocusNavigationPane({
	className,
	pathname,
	showV2Features,
	activeAgentId,
	activeAgent,
	agentsLoaded,
	activeSection,
	onNavigate,
}: FocusNavigationPaneProps) {
	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<SidebarHeader className="px-4 pt-3 pb-2">
				<FocusHeader
					activeAgent={activeAgent}
					activeAgentId={activeAgentId}
					showV2Features={showV2Features}
				/>
			</SidebarHeader>
			<SidebarContent>
				<SidebarMainNavigation
					pathname={pathname}
					showV2Features={showV2Features}
					activeAgentId={activeAgentId}
					activeAgent={activeAgent}
					agentsLoaded={agentsLoaded}
					activeSection={activeSection}
					onNavigate={onNavigate}
				/>
			</SidebarContent>
		</div>
	);
}

function RailFocusButton({
	href,
	label,
	caption,
	active,
	onNavigate,
	onClickCapture,
	onPointerDownCapture,
	onPointerDown,
	onTouchStartCapture,
	onTouchStart,
	showTooltip = true,
	children,
}: {
	href: string;
	label: string;
	caption?: string;
	active: boolean;
	onNavigate?: React.MouseEventHandler<HTMLAnchorElement>;
	onClickCapture?: React.MouseEventHandler<HTMLAnchorElement>;
	onPointerDownCapture?: React.PointerEventHandler<HTMLAnchorElement>;
	onPointerDown?: React.PointerEventHandler<HTMLAnchorElement>;
	onTouchStartCapture?: React.TouchEventHandler<HTMLAnchorElement>;
	onTouchStart?: React.TouchEventHandler<HTMLAnchorElement>;
	showTooltip?: boolean;
	children: React.ReactNode;
}) {
	const hasCaption = Boolean(caption);
	const button = (
		<SidebarMenuButton
			asChild
			size="lg"
			isActive={active}
			aria-label={label}
			className={cn(
				hasCaption
					? "h-[4.5rem] w-full flex-col justify-center gap-1 rounded-lg px-1 py-1"
					: "size-11 justify-center rounded-lg p-0",
			)}
		>
			<Link
				to={href}
				draggable={false}
				onClickCapture={onClickCapture}
				onClick={onNavigate}
				onPointerDownCapture={onPointerDownCapture}
				onPointerDown={onPointerDown}
				onTouchStartCapture={onTouchStartCapture}
				onTouchStart={onTouchStart}
				className="cursor-default"
			>
				{children}
				{caption ? (
					<span
						className={cn(
							"line-clamp-2 block h-[26px] max-w-16 overflow-hidden text-center text-[11px] leading-[13px] font-medium break-words",
							active ? "text-sidebar-accent-foreground" : "text-muted-foreground",
						)}
						title={label}
					>
						{caption}
					</span>
				) : null}
				<span className="sr-only">{label}</span>
			</Link>
		</SidebarMenuButton>
	);
	return (
		<div
			className={cn(
				"group/rail-focus relative flex items-center justify-center",
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
					<TooltipTrigger asChild>{button}</TooltipTrigger>
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
	onClickCapture,
	onPointerDownCapture,
	onTouchStartCapture,
	showTooltip,
}: {
	agent: SidebarEnvironment;
	active: boolean;
	onNavigate: React.MouseEventHandler<HTMLAnchorElement>;
	onClickCapture: React.MouseEventHandler<HTMLAnchorElement>;
	onPointerDownCapture: React.PointerEventHandler<HTMLAnchorElement>;
	onTouchStartCapture: React.TouchEventHandler<HTMLAnchorElement>;
	showTooltip: boolean;
}) {
	const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: agent.id,
	});
	const hosted = isHostedAgentEnvironment(agent);
	const label = agentTextLabel(agent);
	const caption = displayMachineName(agentDisplayName(agent));
	const href = agentSectionHref(agent.id);
	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition: isDragging ? undefined : transition,
		zIndex: isDragging ? 20 : undefined,
	};
	const dragPointerDown: React.PointerEventHandler<HTMLAnchorElement> | undefined =
		listeners?.onPointerDown ? (event) => listeners.onPointerDown?.(event) : undefined;
	const dragTouchStart: React.TouchEventHandler<HTMLAnchorElement> | undefined =
		listeners?.onTouchStart ? (event) => listeners.onTouchStart?.(event) : undefined;

	return (
		<SidebarMenuItem
			ref={setNodeRef}
			style={style}
			className={cn(
				"group/agent-rail-item relative w-full touch-pan-y will-change-transform",
				isDragging && "opacity-80",
			)}
		>
			<RailFocusButton
				href={href}
				label={label}
				caption={caption}
				active={active}
				onNavigate={onNavigate}
				onClickCapture={onClickCapture}
				onPointerDownCapture={onPointerDownCapture}
				onPointerDown={dragPointerDown}
				onTouchStartCapture={onTouchStartCapture}
				onTouchStart={dragTouchStart}
				showTooltip={showTooltip}
			>
				<span className="relative inline-flex rounded-md">
					<AgentIcon agent={agent.agent_type} size="rail" avatarUrl={agent.avatar_url} />
					{hosted ? (
						<span
							title="Clawdi Cloud agent"
							className="-top-1 -right-1 pointer-events-none absolute z-20 flex size-4 items-center justify-center rounded-full bg-sky-500 text-white ring-2 ring-sidebar dark:bg-sky-400 dark:text-sky-950"
						>
							<Cloud aria-hidden="true" className="size-2.5" />
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
	user,
	onSearch,
	onSettings,
	settingsOpen,
	onNavigate,
	showTooltips = true,
}: {
	agents: SidebarEnvironment[];
	activeAgentId: string | null;
	user: ReturnType<typeof useCurrentUser>["user"];
	onSearch: () => void;
	onSettings: () => void;
	settingsOpen: boolean;
	onNavigate?: () => void;
	showTooltips?: boolean;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const draggingRailItem = useRef(false);
	const railPointerStart = useRef<{ x: number; y: number } | null>(null);
	const suppressCurrentRailPointerClick = useRef(false);
	const [railAgents, setRailAgents] = useState<SidebarEnvironment[]>(() =>
		[...agents].sort(compareAgentEnvironments),
	);
	const railAgentsRef = useRef(railAgents);
	const dragStartRailAgents = useRef<SidebarEnvironment[] | null>(null);
	const setRailAgentsOrder = (next: SidebarEnvironment[]) => {
		railAgentsRef.current = next;
		setRailAgents(next);
	};
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: RAIL_DRAG_ACTIVATION_DISTANCE } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
	);
	useEffect(() => {
		if (!draggingRailItem.current) {
			setRailAgentsOrder([...agents].sort(compareAgentEnvironments));
		}
	}, [agents]);
	const orderedAgents = railAgents;
	const orderedAgentIds = orderedAgents.map((agent) => agent.id);
	const reorderAgents = useMutation({
		mutationFn: async (environmentIds: string[]) =>
			unwrap(
				await api.PATCH("/api/environments/order", { body: { environment_ids: environmentIds } }),
			),
		onMutate: async (environmentIds) => {
			await queryClient.cancelQueries({ queryKey: ["environments"] });
			const previous = queryClient.getQueryData<SidebarEnvironment[]>(["environments"]);
			queryClient.setQueryData<SidebarEnvironment[]>(["environments"], (current) =>
				current ? reorderEnvironmentsForCache(current, environmentIds) : current,
			);
			return { previous };
		},
		onError: (error, _environmentIds, context) => {
			if (context?.previous) {
				queryClient.setQueryData(["environments"], context.previous);
				setRailAgentsOrder([...context.previous].sort(compareAgentEnvironments));
			}
			toast.error("Couldn't reorder agents", { description: errorMessage(error) });
		},
		onSuccess: (data) => {
			queryClient.setQueryData(["environments"], data);
			setRailAgentsOrder([...data].sort(compareAgentEnvironments));
		},
	});
	const onDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		draggingRailItem.current = false;
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
				finalAgents = reorderEnvironmentsByIndex(finalAgents, from, to);
				setRailAgentsOrder(finalAgents);
				finalIds = finalAgents.map((agent) => agent.id);
			}
		}
		if (sameOrder(initialIds, finalIds)) return;
		reorderAgents.mutate(finalIds);
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
		setRailAgentsOrder(reorderEnvironmentsByIndex(current, from, to));
	};
	const beginRailDragGesture = () => {
		draggingRailItem.current = true;
		dragStartRailAgents.current = railAgentsRef.current;
		suppressCurrentRailPointerClick.current = true;
	};
	const recordRailPointerStart: React.PointerEventHandler<HTMLAnchorElement> = (event) => {
		suppressCurrentRailPointerClick.current = false;
		if (event.pointerType === "mouse" && event.button !== 0) {
			railPointerStart.current = null;
			return;
		}
		railPointerStart.current = { x: event.clientX, y: event.clientY };
	};
	const recordRailTouchStart: React.TouchEventHandler<HTMLAnchorElement> = (event) => {
		suppressCurrentRailPointerClick.current = false;
		const touch = event.touches.item(0);
		railPointerStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
	};
	const railClickMovedPastDragThreshold = (event: React.MouseEvent<HTMLAnchorElement>) => {
		const start = railPointerStart.current;
		if (!start) return false;
		const dx = event.clientX - start.x;
		const dy = event.clientY - start.y;
		return Math.hypot(dx, dy) >= RAIL_DRAG_ACTIVATION_DISTANCE;
	};
	const shouldSuppressRailClick = (event: React.MouseEvent<HTMLAnchorElement>) =>
		draggingRailItem.current ||
		suppressCurrentRailPointerClick.current ||
		railClickMovedPastDragThreshold(event);
	const suppressRailNavigation = (event: React.MouseEvent<HTMLAnchorElement>) => {
		event.preventDefault();
		event.stopPropagation();
		suppressCurrentRailPointerClick.current = false;
		railPointerStart.current = null;
	};
	const onRailAgentClickCapture: React.MouseEventHandler<HTMLAnchorElement> = (event) => {
		if (shouldSuppressRailClick(event)) {
			suppressRailNavigation(event);
		}
	};
	const onRailAgentNavigate: React.MouseEventHandler<HTMLAnchorElement> = (event) => {
		if (event.defaultPrevented) return;
		if (shouldSuppressRailClick(event)) {
			suppressRailNavigation(event);
		} else {
			railPointerStart.current = null;
			onNavigate?.();
		}
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

			<SidebarContent className="items-center gap-2 overflow-x-hidden overflow-y-auto px-2.5 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				<SidebarMenu className="items-center">
					<SidebarMenuItem>
						<RailFocusButton
							href="/"
							label="Console"
							caption="Console"
							active={!activeAgentId}
							onNavigate={onNavigate}
							showTooltip={showTooltips}
						>
							<RailIconChip tint={RESOURCE_TINT_CLASSES.overview}>
								<LayoutDashboard />
							</RailIconChip>
						</RailFocusButton>
					</SidebarMenuItem>
				</SidebarMenu>

				<SidebarSeparator className="mx-auto w-8" />

				<SidebarMenu className="w-full items-center gap-1">
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						modifiers={RAIL_DND_MODIFIERS}
						onDragStart={beginRailDragGesture}
						onDragCancel={() => {
							draggingRailItem.current = false;
							if (dragStartRailAgents.current) {
								setRailAgentsOrder(dragStartRailAgents.current);
							} else {
								setRailAgentsOrder([...agents].sort(compareAgentEnvironments));
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
									active={activeAgentId === agent.id}
									onNavigate={onRailAgentNavigate}
									onClickCapture={onRailAgentClickCapture}
									onPointerDownCapture={recordRailPointerStart}
									onTouchStartCapture={recordRailTouchStart}
									showTooltip={showTooltips}
								/>
							))}
						</SortableContext>
					</DndContext>
					<NewAgentButton compact showTooltip={showTooltips} onNavigate={onNavigate} />
				</SidebarMenu>
			</SidebarContent>

			<SidebarFooter className="items-center border-t p-2.5">
				<GlobalControls
					user={user}
					onSearch={onSearch}
					onSettings={onSettings}
					settingsOpen={settingsOpen}
					showTooltips={showTooltips}
				/>
			</SidebarFooter>
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
	hosted: boolean,
): {
	visibleLabel: string;
	detailLabel: string;
	activityLabel: string;
} {
	const sourceDetail = hosted ? agentSourceKindLabel("hosted") : null;
	const typeLabel = agentTypeLabel(agent.agent_type);
	const version = agentVersionLabel(agent.agent_version);
	const relativeSeen = agent.last_seen_at ? relativeTime(agent.last_seen_at) : null;
	const activityLabel = relativeSeen ? `last seen ${relativeSeen}` : "never seen";
	const visible = [hosted ? `${typeLabel} runtime` : typeLabel, agent.os?.trim() || null].filter(
		(item): item is string => Boolean(item),
	);
	const detail = [
		sourceDetail,
		hosted ? `${typeLabel} runtime` : typeLabel,
		version,
		agent.os?.trim() || null,
	].filter((item): item is string => Boolean(item));
	return { visibleLabel: visible.join(" · "), detailLabel: detail.join(" · "), activityLabel };
}

function FocusHeader({
	activeAgent,
	activeAgentId,
	showV2Features,
}: {
	activeAgent: SidebarEnvironment | null;
	activeAgentId: string | null;
	showV2Features: boolean;
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

	if (!activeAgent) {
		return (
			<div className="min-w-0">
				<div className="truncate text-sm font-semibold leading-5">
					{showV2Features ? "Clawdi Cloud agent" : "Agent"}
				</div>
				<div className="truncate text-xs leading-4 text-muted-foreground">
					{activeAgentId ? activeAgentId.slice(0, 8) : "Loading navigation"}
				</div>
			</div>
		);
	}

	const name = agentDisplayName(activeAgent);
	const displayName = displayMachineName(name);
	const hosted = showV2Features && isHostedAgentEnvironment(activeAgent);
	const meta = agentHeaderMeta(activeAgent, hosted);
	const title = [name, meta.detailLabel, meta.activityLabel].filter(Boolean).join(" · ");
	return (
		<div className="min-w-0 text-left">
			<div className="flex min-w-0 items-center gap-2" title={title}>
				<span className="truncate text-sm font-semibold leading-5">{displayName}</span>
				<AgentSourceBadgeForEnvironment env={activeAgent} compact />
			</div>
			{meta.visibleLabel ? (
				<div
					className="mt-1 truncate text-xs leading-4 text-muted-foreground"
					title={meta.detailLabel}
				>
					{meta.visibleLabel}
				</div>
			) : null}
			<div className="mt-2 flex min-w-0 items-center justify-between gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/45 px-2 py-1 text-xs leading-4">
				<DaemonStatusBadge
					env={activeAgent}
					source={hosted ? "on-clawdi" : "self-managed"}
					manageHref={hosted ? agentSectionHref(activeAgent.id, "settings") : undefined}
					compact
					tooltipDetail={meta.detailLabel}
				/>
				<span className="min-w-0 truncate text-muted-foreground" title={meta.activityLabel}>
					{meta.activityLabel}
				</span>
			</div>
		</div>
	);
}

function RailSidebar({
	agents,
	activeAgentId,
	user,
	onSearch,
	onSettings,
	settingsOpen,
}: {
	agents: SidebarEnvironment[];
	activeAgentId: string | null;
	user: ReturnType<typeof useCurrentUser>["user"];
	onSearch: () => void;
	onSettings: () => void;
	settingsOpen: boolean;
}) {
	return (
		<Sidebar
			collapsible="none"
			style={{ "--sidebar-width": "var(--clawdi-rail-width)" } as React.CSSProperties}
			className="sticky top-0 hidden h-svh shrink-0 border-r bg-sidebar/95 md:flex"
			aria-label="Focus rail"
		>
			<FocusRailContent
				agents={agents}
				activeAgentId={activeAgentId}
				user={user}
				onSearch={onSearch}
				onSettings={onSettings}
				settingsOpen={settingsOpen}
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
		<>
			<DropdownMenuItem asChild>
				<a href="https://deepwiki.com/Clawdi-AI/clawdi" target="_blank" rel="noopener noreferrer">
					<BookOpen />
					Docs
					<ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
				</a>
			</DropdownMenuItem>
			<DropdownMenuItem asChild>
				<a href="https://github.com/Clawdi-AI/clawdi" target="_blank" rel="noopener noreferrer">
					<GitHubIcon />
					GitHub
					<ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
				</a>
			</DropdownMenuItem>
			<DropdownMenuItem asChild>
				<a href="mailto:support@clawdi.ai">
					<Mail />
					support@clawdi.ai
				</a>
			</DropdownMenuItem>
			<DropdownMenuItem asChild>
				<a href="https://t.me/clawdiofficial" target="_blank" rel="noopener noreferrer">
					<MessageCircle />
					Telegram @clawdiofficial
				</a>
			</DropdownMenuItem>
		</>
	);
}

function GlobalControlButton({
	label,
	children,
	onClick,
	active = false,
	tooltipSide = "right",
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
			className="rounded-lg"
		>
			{children}
		</Button>
	);
	if (!showTooltip) return button;
	return (
		<Tooltip>
			<TooltipTrigger asChild>{button}</TooltipTrigger>
			<TooltipContent side={tooltipSide}>{label}</TooltipContent>
		</Tooltip>
	);
}

function HelpControl({ showTooltip = true }: { showTooltip?: boolean }) {
	const trigger = (
		<DropdownMenuTrigger asChild>
			<Button type="button" variant="ghost" size="icon-lg" aria-label="Help" className="rounded-lg">
				<CircleHelp />
			</Button>
		</DropdownMenuTrigger>
	);
	return (
		<DropdownMenu>
			{showTooltip ? (
				<Tooltip>
					<TooltipTrigger asChild>{trigger}</TooltipTrigger>
					<TooltipContent side="right">Help</TooltipContent>
				</Tooltip>
			) : (
				trigger
			)}
			<DropdownMenuContent side="right" align="end" className="min-w-56">
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
		<DropdownMenuTrigger asChild>
			<Button
				type="button"
				variant="ghost"
				size="icon-lg"
				className="rounded-lg"
				aria-label="User menu"
			>
				<Avatar className="size-8 rounded-md">
					{user?.imageUrl ? <AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} /> : null}
					<AvatarFallback className="rounded-md">{initial}</AvatarFallback>
				</Avatar>
			</Button>
		</DropdownMenuTrigger>
	);
	return (
		<DropdownMenu>
			{showTooltip ? (
				<Tooltip>
					<TooltipTrigger asChild>{trigger}</TooltipTrigger>
					<TooltipContent side="right">User menu</TooltipContent>
				</Tooltip>
			) : (
				trigger
			)}
			<DropdownMenuContent className="min-w-56 rounded-lg" side="right" align="end">
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
	return (
		<SidebarMenu className="items-center gap-1">
			<SidebarMenuItem>
				<GlobalControlButton label="Search" onClick={onSearch} showTooltip={showTooltips}>
					<Search />
				</GlobalControlButton>
			</SidebarMenuItem>
			<SidebarMenuItem>
				<HelpControl showTooltip={showTooltips} />
			</SidebarMenuItem>
			<SidebarMenuItem>
				<GlobalControlButton
					label="Settings"
					onClick={onSettings}
					active={settingsOpen}
					showTooltip={showTooltips}
				>
					<Settings />
				</GlobalControlButton>
			</SidebarMenuItem>
			<SidebarMenuItem>
				<UserControl user={user} showTooltip={showTooltips} />
			</SidebarMenuItem>
		</SidebarMenu>
	);
}

export function AppSidebar({
	className,
	variant,
	style,
	...props
}: React.ComponentProps<typeof Sidebar>) {
	const pathname = useLocation({ select: (location) => location.pathname });
	const { user } = useCurrentUser();
	const { setOpen: setPaletteOpen } = useCommandPalette();
	const { isMobile, setOpenMobile } = useSidebar();
	const api = useApi();
	const v2Access = useV2Access();
	const [mounted, setMounted] = useState(false);
	useEffect(() => {
		setMounted(true);
	}, []);
	const showV2Features = mounted && IS_HOSTED && v2Access.canUseV2;
	const agentRoute = parseAgentPathname(pathname);
	const activeAgentId = agentRoute?.agentId ?? null;
	const { data: environments } = useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
		refetchInterval: activeAgentId ? 10_000 : false,
	});
	const hydratedEnvironments = mounted ? environments : undefined;
	const agentsLoaded = hydratedEnvironments !== undefined;
	const agents = hydratedEnvironments ?? [];
	const activeAgent = activeAgentId ? agents.find((env) => env.id === activeAgentId) : null;
	const activeSection = agentRoute?.section ?? "overview";
	const [settingsSection, setSettingsSection] = useQueryState(
		SETTINGS_QUERY_KEY,
		parseAsStringLiteral(SETTINGS_SECTION_IDS).withOptions({ history: "replace" }),
	);
	const settingsOpen = settingsSection !== null;
	const activeSettingsSection = settingsSection ?? DEFAULT_SETTINGS_SECTION;
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
			{!isMobile ? (
				<RailSidebar
					agents={agents}
					activeAgentId={activeAgentId}
					user={user}
					onSearch={openSearch}
					onSettings={openSettingsFromSidebar}
					settingsOpen={settingsOpen}
				/>
			) : null}
			<Sidebar
				collapsible="offcanvas"
				variant={variant}
				style={
					{
						...style,
						"--sidebar-left-offset": "var(--clawdi-rail-width)",
					} as React.CSSProperties
				}
				className={className}
				{...props}
			>
				{!isMobile ? (
					<FocusNavigationPane
						pathname={pathname}
						showV2Features={showV2Features}
						activeAgentId={activeAgentId}
						activeAgent={activeAgent ?? null}
						agentsLoaded={agentsLoaded}
						activeSection={activeSection}
					/>
				) : null}

				{isMobile ? (
					<div className="flex min-h-0 flex-1">
						<nav
							className="flex w-(--clawdi-rail-width) shrink-0 flex-col border-r bg-sidebar/95"
							aria-label="Focus rail"
						>
							<FocusRailContent
								agents={agents}
								activeAgentId={activeAgentId}
								user={user}
								onSearch={openSearch}
								onSettings={openSettingsFromSidebar}
								settingsOpen={settingsOpen}
								onNavigate={closeMobileSidebar}
								showTooltips={false}
							/>
						</nav>
						<FocusNavigationPane
							className="min-w-0"
							pathname={pathname}
							showV2Features={showV2Features}
							activeAgentId={activeAgentId}
							activeAgent={activeAgent ?? null}
							agentsLoaded={agentsLoaded}
							activeSection={activeSection}
							onNavigate={closeMobileSidebar}
						/>
					</div>
				) : null}
			</Sidebar>
			<SettingsDialog
				open={settingsOpen}
				section={activeSettingsSection}
				onSectionChange={changeSettingsSection}
				onOpenChange={setSettingsOpen}
			/>
		</>
	);
}
