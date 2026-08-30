import { Bot, FolderKanban, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { agentIdentity } from "@/components/dashboard/agent-label";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { identityFor } from "@/lib/identity";
import { searchExcerpt } from "@/lib/search-highlight";
import { cn } from "@/lib/utils";

export interface ProjectMetadata {
	id?: string;
	name: string;
	slug: string;
	description?: string | null;
	kind?: string;
	origin_environment_id?: string | null;
	is_owner?: boolean;
	owner_display?: string | null;
	owner_handle?: string | null;
}

export interface ProjectAgentMetadata {
	id: string;
	name?: string | null;
	display_name?: string | null;
	default_name?: string | null;
	machine_name?: string | null;
	agent_type?: string | null;
}

export function isProjectOwner(project: Pick<ProjectMetadata, "is_owner">): boolean {
	return project.is_owner !== false;
}

export function displayProjectName(project: Pick<ProjectMetadata, "kind" | "name" | "slug">) {
	return project.name;
}

function projectOwnerLabel(project: ProjectMetadata) {
	if (isProjectOwner(project)) return "You";
	return project.owner_display ?? project.owner_handle ?? "Unknown";
}

export function projectSupportingText(project: ProjectMetadata) {
	const description = project.description?.trim();
	if (description) return description;
	if (!isProjectOwner(project)) return `Shared by ${projectOwnerLabel(project)}`;
	if (project.kind === "environment") return "Private Agent Workspace";
	return "Project you own";
}

export function projectSearchRank(project: ProjectMetadata, query: string): number | null {
	const phrase = query.trim().toLowerCase();
	if (!phrase) return 0;
	const name = displayProjectName(project).toLowerCase();
	const slug = project.slug.toLowerCase();
	if (name === phrase) return 0;
	if (slug === phrase) return 1;
	if (name.startsWith(phrase)) return 2;
	if (slug.startsWith(phrase)) return 3;
	if (name.includes(phrase)) return 4;
	if (slug.includes(phrase)) return 5;
	if (project.description?.toLowerCase().includes(phrase)) return 6;
	if (
		!isProjectOwner(project) &&
		[project.owner_display, project.owner_handle].some((owner) =>
			owner?.toLowerCase().includes(phrase),
		)
	) {
		return 7;
	}
	return null;
}

export function projectMatchesSearch(project: ProjectMetadata, query: string): boolean {
	return projectSearchRank(project, query) !== null;
}

export function projectSearchSupportingText(project: ProjectMetadata, query: string): string {
	const phrase = query.trim().toLowerCase();
	if (!phrase) return projectSupportingText(project);

	if (project.slug.toLowerCase().includes(phrase)) return `Slug: ${project.slug}`;

	const description = project.description?.trim();
	if (description?.toLowerCase().includes(phrase)) {
		return searchExcerpt(description, query, 160);
	}

	const matchingOwner = [project.owner_display, project.owner_handle].find((owner) =>
		owner?.toLowerCase().includes(phrase),
	);
	if (!isProjectOwner(project) && matchingOwner) {
		return `Shared by ${matchingOwner}`;
	}
	return projectSupportingText(project);
}

export function isCustomProject(project: Pick<ProjectMetadata, "kind">): boolean {
	return project.kind === "workspace" || !project.kind;
}

export function canManageCustomProject(
	project: Pick<ProjectMetadata, "is_owner" | "kind">,
): boolean {
	return isProjectOwner(project) && isCustomProject(project);
}

export function projectKindSortRank(kind?: string): number {
	if (kind === "workspace" || !kind) return 0;
	if (kind === "personal") return 1;
	if (kind === "environment") return 2;
	return 4;
}

export function compareProjectsForUse(a: ProjectMetadata, b: ProjectMetadata) {
	const rank = (project: ProjectMetadata) => {
		if (!isProjectOwner(project)) return 3;
		return projectKindSortRank(project.kind);
	};
	const byRank = rank(a) - rank(b);
	if (byRank !== 0) return byRank;
	return displayProjectName(a).localeCompare(displayProjectName(b));
}

export function ProjectIdentity({
	project,
	agent,
	className,
	badges,
	showKind = true,
	showAccess = true,
	showAgent = true,
	showIcon = true,
	titleClassName,
}: {
	project: ProjectMetadata;
	agent?: ProjectAgentMetadata | null;
	className?: string;
	badges?: ReactNode;
	showKind?: boolean;
	showAccess?: boolean;
	showAgent?: boolean;
	showIcon?: boolean;
	titleClassName?: string;
}) {
	const projectAgent = showAgent && project.kind === "environment" ? agent : null;
	const agentLine = projectAgent ? projectAgentLabel(projectAgent) : null;
	const supportingText = projectSupportingText(project);
	return (
		<div className={cn("flex min-w-0 items-start gap-3", className)}>
			{showIcon ? <ProjectIcon project={project} agent={agent} /> : null}
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<span
						className={cn("min-w-0 max-w-full truncate text-sm font-semibold", titleClassName)}
						title={displayProjectName(project)}
					>
						{displayProjectName(project)}
					</span>
					{showKind && project.kind ? <ProjectKindBadge kind={project.kind} /> : null}
					{badges}
					{showAccess ? <ProjectAccessBadge project={project} /> : null}
				</div>
				{supportingText || projectAgent ? (
					<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						<TruncatedText className="min-w-0">{supportingText}</TruncatedText>
						{agentLine ? (
							<TruncatedText className="min-w-0" translate="no" title={`Agent: ${agentLine}`}>
								Agent: {agentLine}
							</TruncatedText>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
}

function ProjectIcon({
	project,
	className,
}: {
	project: Pick<ProjectMetadata, "kind" | "name" | "slug">;
	agent?: ProjectAgentMetadata | null;
	className?: string;
}) {
	const meta = projectKindMeta(project.kind ?? "workspace");
	// Emoji avatar + vivid tile, deterministic per project name — so a list
	// of 100 projects reads as 100 different objects, not 100 folders.
	const id = identityFor(project.name ?? project.slug);
	return (
		<span
			className={cn(
				"mt-0.5 flex size-6 shrink-0 select-none items-center justify-center rounded-md text-xs leading-none",
				id.colorClasses,
				className,
			)}
			title={meta.label}
		>
			{id.emoji}
		</span>
	);
}

function ProjectAccessBadge({
	project,
	className,
}: {
	project: Pick<ProjectMetadata, "is_owner">;
	className?: string;
}) {
	const owner = isProjectOwner(project);
	return (
		<Badge
			variant="outline"
			className={cn(
				"border-border/70 bg-background/50 text-xs text-muted-foreground",
				!owner && "bg-muted/60 text-foreground",
				className,
			)}
		>
			{owner ? "Owner" : "Viewer"}
		</Badge>
	);
}

export function ProjectKindBadge({ kind, className }: { kind: string; className?: string }) {
	const meta = projectKindMeta(kind);
	const Icon = meta.icon;
	return (
		<Badge
			variant="outline"
			className={cn("gap-1 border text-xs", meta.badgeClassName, className)}
			title={meta.description}
		>
			<Icon className="size-3" />
			{meta.label}
		</Badge>
	);
}

export function ProjectScopePicker({
	projects,
	agents,
	value,
	onValueChange,
	label = "Project",
	placeholder = "Choose project…",
	allowAll = false,
	allLabel = "All Readable Projects",
	allDescription = "Show every Project you can read",
	disabled,
	layout = "inline",
	className,
	triggerClassName,
}: {
	projects: ProjectMetadata[];
	agents?: ProjectAgentMetadata[];
	value: string;
	onValueChange: (value: string) => void;
	label?: string;
	placeholder?: string;
	allowAll?: boolean;
	allLabel?: string;
	allDescription?: string;
	disabled?: boolean;
	layout?: "inline" | "stacked";
	className?: string;
	triggerClassName?: string;
}) {
	const visibleProjects = projects.filter((project) => project.kind !== "personal");
	const selectedProject = visibleProjects.find((project) => project.id === value) ?? null;
	const agentsById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
	const selectedAgent = selectedProject ? projectAgentFor(selectedProject, agentsById) : null;
	const groupedProjects = projectPickerGroups(visibleProjects);
	const projectItems = [
		...(allowAll ? [{ value: "all", label: allLabel }] : []),
		...visibleProjects.flatMap((project) =>
			project.id ? [{ value: project.id, label: displayProjectName(project) }] : [],
		),
	];
	const isStacked = layout === "stacked";
	return (
		<div
			className={cn(
				isStacked
					? "grid min-w-0 gap-1.5 text-sm"
					: "flex min-w-0 flex-wrap items-center gap-2 text-sm sm:gap-3",
				className,
			)}
		>
			{label ? (
				<span
					className={cn(
						"shrink-0 text-muted-foreground",
						isStacked && "text-xs font-medium text-foreground",
					)}
				>
					{label}
				</span>
			) : null}
			<Select
				items={projectItems}
				value={value}
				onValueChange={(nextValue) => {
					if (nextValue !== null) onValueChange(nextValue);
				}}
				disabled={disabled}
			>
				<SelectTrigger
					aria-label={label}
					className={cn(
						"h-auto min-h-16 w-full max-w-full justify-between rounded-md border bg-card px-3 py-2.5 whitespace-normal transition-colors hover:bg-muted/50",
						isStacked ? "min-w-0" : "min-w-[260px] sm:w-[420px]",
						triggerClassName,
					)}
				>
					{selectedProject ? (
						<ProjectPickerValue project={selectedProject} agent={selectedAgent} />
					) : value === "all" && allowAll ? (
						<ProjectPickerAllItem label={allLabel} description={allDescription} compact />
					) : (
						<SelectValue placeholder={placeholder} />
					)}
				</SelectTrigger>
				<SelectContent
					align="start"
					alignItemWithTrigger={false}
					className="w-(--anchor-width) min-w-[min(420px,calc(100vw-2rem))]"
				>
					{allowAll ? (
						<SelectItem value="all" className="py-2">
							<ProjectPickerAllItem label={allLabel} description={allDescription} />
						</SelectItem>
					) : null}
					{allowAll && groupedProjects.length > 0 ? <SelectSeparator /> : null}
					{groupedProjects.map((group, groupIndex) => (
						<SelectGroup key={group.id}>
							<SelectLabel className="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide">
								{group.label}
							</SelectLabel>
							{group.projects.map((project) =>
								project.id ? (
									<SelectItem key={project.id} value={project.id} className="py-2">
										<ProjectPickerOption
											project={project}
											agent={projectAgentFor(project, agentsById)}
										/>
									</SelectItem>
								) : null,
							)}
							{groupIndex < groupedProjects.length - 1 ? <SelectSeparator /> : null}
						</SelectGroup>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

export function ProjectCompactPicker({
	projects,
	agents,
	value,
	onValueChange,
	allowAll = false,
	allLabel = "All Projects",
	allDescription = "Show every Project you can read",
	placeholder = "Project",
	ariaLabel = "Project filter",
	disabled,
	className,
}: {
	projects: ProjectMetadata[];
	agents?: ProjectAgentMetadata[];
	value: string;
	onValueChange: (value: string) => void;
	allowAll?: boolean;
	allLabel?: string;
	allDescription?: string;
	placeholder?: string;
	ariaLabel?: string;
	disabled?: boolean;
	className?: string;
}) {
	const visibleProjects = projects.filter((project) => project.kind !== "personal");
	const selectedProject = visibleProjects.find((project) => project.id === value) ?? null;
	const agentsById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
	const projectItems = [
		...(allowAll ? [{ value: "all", label: allLabel }] : []),
		...visibleProjects.flatMap((project) =>
			project.id ? [{ value: project.id, label: displayProjectName(project) }] : [],
		),
	];
	return (
		<Select
			items={projectItems}
			value={value}
			onValueChange={(nextValue) => {
				if (nextValue !== null) onValueChange(nextValue);
			}}
			disabled={disabled}
		>
			<SelectTrigger
				aria-label={ariaLabel}
				className={cn(
					"h-9 w-full min-w-0 justify-between border-border/80 bg-background/70 px-3 shadow-xs",
					className,
				)}
			>
				{selectedProject ? (
					<span className="flex min-w-0 items-center gap-2 text-left">
						<ProjectIcon project={selectedProject} className="mt-0 size-5 rounded-md" />
						<TruncatedText className="min-w-0 font-medium">
							{displayProjectName(selectedProject)}
						</TruncatedText>
						<span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
							{projectCompactKindText(selectedProject)}
						</span>
					</span>
				) : value === "all" && allowAll ? (
					<span className="flex min-w-0 items-center gap-2 text-left">
						<span className="flex size-5 shrink-0 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground">
							<FolderKanban className="size-3" />
						</span>
						<TruncatedText className="font-medium">{allLabel}</TruncatedText>
					</span>
				) : (
					<SelectValue placeholder={placeholder} />
				)}
			</SelectTrigger>
			<SelectContent
				align="start"
				alignItemWithTrigger={false}
				className="w-(--anchor-width) min-w-[min(420px,calc(100vw-2rem))]"
			>
				{allowAll ? (
					<SelectItem value="all" className="py-2">
						<div className="flex min-w-0 items-center gap-2">
							<span className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground">
								<FolderKanban className="size-3.5" />
							</span>
							<div className="min-w-0">
								<div className="truncate font-medium" title={allLabel}>
									{allLabel}
								</div>
								<div className="truncate text-xs text-muted-foreground">{allDescription}</div>
							</div>
						</div>
					</SelectItem>
				) : null}
				{allowAll && visibleProjects.length > 0 ? <SelectSeparator /> : null}
				{visibleProjects.map((project) =>
					project.id ? (
						<SelectItem key={project.id} value={project.id} className="py-2">
							<ProjectIdentity
								project={project}
								agent={projectAgentFor(project, agentsById)}
								showAccess
								titleClassName="text-sm"
							/>
						</SelectItem>
					) : null,
				)}
			</SelectContent>
		</Select>
	);
}

function ProjectPickerValue({
	project,
	agent,
}: {
	project: ProjectMetadata;
	agent?: ProjectAgentMetadata | null;
}) {
	return (
		<span className="flex min-w-0 flex-1 items-center gap-3 pr-1 text-left">
			<ProjectIcon project={project} agent={agent} className="mt-0 size-7 rounded-md" />
			<span className="grid min-w-0 flex-1 gap-0.5">
				<TruncatedText className="text-sm leading-5 font-semibold">
					{displayProjectName(project)}
				</TruncatedText>
				<TruncatedText className="min-w-0 text-xs leading-4 text-muted-foreground">
					{projectSupportingText(project)}
				</TruncatedText>
			</span>
		</span>
	);
}

function ProjectPickerOption({
	project,
	agent,
}: {
	project: ProjectMetadata;
	agent?: ProjectAgentMetadata | null;
}) {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<ProjectIcon project={project} agent={agent} className="mt-0 size-6 rounded-md" />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<TruncatedText className="font-medium">{displayProjectName(project)}</TruncatedText>
					<ProjectTypeBadge project={project} />
				</div>
				<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
					<TruncatedText className="min-w-0">{projectSupportingText(project)}</TruncatedText>
					<span className="shrink-0">·</span>
					<span className="shrink-0">{projectPickerAccessText(project)}</span>
					{project.kind === "environment" && agent ? (
						<>
							<span className="shrink-0">·</span>
							<TruncatedText className="min-w-0" translate="no">
								{projectAgentLabel(agent)}
							</TruncatedText>
						</>
					) : null}
				</div>
			</div>
		</div>
	);
}

function ProjectPickerAllItem({
	label,
	description,
	compact = false,
}: {
	label: string;
	description: string;
	compact?: boolean;
}) {
	return (
		<span className="flex min-w-0 items-center gap-2 text-left">
			<span
				className={cn(
					"flex shrink-0 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground",
					compact ? "size-7" : "size-6",
				)}
			>
				<FolderKanban className={compact ? "size-3.5" : "size-3.5"} />
			</span>
			<span className={cn("min-w-0", compact && "grid gap-0.5")}>
				<TruncatedText className={cn("block font-medium", compact && "text-sm leading-5")}>
					{label}
				</TruncatedText>
				<TruncatedText className="block text-xs text-muted-foreground">{description}</TruncatedText>
			</span>
		</span>
	);
}

function projectCompactKindText(project: ProjectMetadata) {
	if (project.is_owner === false) return "Shared";
	return ownedProjectKindText(project, "compact");
}

function ownedProjectKindText(
	project: Pick<ProjectMetadata, "kind">,
	_variant: "full" | "compact" | "badge",
) {
	if (project.kind === "workspace" || !project.kind) {
		return "Project";
	}
	if (project.kind === "personal") return "Private resources";
	if (project.kind === "environment") return "Workspace";
	return "Project";
}

function ProjectTypeBadge({
	project,
	compact = false,
}: {
	project: ProjectMetadata;
	compact?: boolean;
}) {
	const text = project.is_owner === false ? "Shared" : ownedProjectKindText(project, "badge");
	return (
		<Badge
			variant="outline"
			className={cn(
				"shrink-0 border-border/70 px-1.5 py-0 text-2xs font-normal text-muted-foreground",
				compact && "hidden sm:inline-flex",
			)}
		>
			{text}
		</Badge>
	);
}

function projectPickerAccessText(project: ProjectMetadata) {
	if (project.is_owner === false) return "Viewer";
	if (project.kind === "workspace" || !project.kind) return "Owner";
	return "Owner";
}

export function projectKindMeta(kind: string): {
	label: string;
	groupLabel: string;
	description: string;
	icon: LucideIcon;
	iconClassName: string;
	badgeClassName: string;
} {
	if (kind === "workspace") {
		return {
			label: "Project",
			groupLabel: "Projects",
			description: "Project you create for a workflow, team, or shareable resources.",
			icon: FolderKanban,
			iconClassName: "border-border bg-muted/50 text-muted-foreground",
			badgeClassName: "border-border bg-muted/50 text-muted-foreground",
		};
	}
	if (kind === "environment") {
		return {
			label: "Workspace",
			groupLabel: "Agent Workspaces",
			description: "Private Workspace permanently used by one Agent.",
			icon: Bot,
			iconClassName: "border-border bg-muted/50 text-muted-foreground",
			badgeClassName: "border-border bg-muted/50 text-muted-foreground",
		};
	}
	if (kind === "personal") {
		return {
			label: "Private resources",
			groupLabel: "Private resources",
			description: "Private library item.",
			icon: FolderKanban,
			iconClassName: "border-border bg-muted/50 text-muted-foreground",
			badgeClassName: "border-border bg-muted/50 text-muted-foreground",
		};
	}
	return {
		label: "Project",
		groupLabel: "Projects",
		description: "Resource bundle.",
		icon: FolderKanban,
		iconClassName: "border-border bg-muted/30 text-muted-foreground",
		badgeClassName: "border-border bg-muted/30 text-muted-foreground",
	};
}

export function projectAgentLabel(agent: ProjectAgentMetadata) {
	const hasIdentity = Boolean(
		agent.display_name ||
			agent.default_name ||
			agent.name ||
			agent.machine_name ||
			agent.agent_type,
	);
	if (!hasIdentity) return "Agent";
	return agentIdentity(agent).primaryLabel;
}

export function projectAgentFor(
	project: Pick<ProjectMetadata, "origin_environment_id">,
	agentsById: ReadonlyMap<string, ProjectAgentMetadata>,
): ProjectAgentMetadata | null {
	return project.origin_environment_id
		? (agentsById.get(project.origin_environment_id) ?? null)
		: null;
}

function projectPickerGroups(projects: ProjectMetadata[]) {
	const owned = projects.filter((project) => isProjectOwner(project));
	const shared = projects.filter((project) => !isProjectOwner(project));
	const groups = [
		{
			id: "projects",
			label: "Projects",
			projects: owned.filter(isCustomProject),
		},
		{
			id: "workspaces",
			label: "Agent Workspaces",
			projects: owned.filter((project) => project.kind === "environment"),
		},
		{
			id: "other",
			label: "Other Projects",
			projects: owned.filter(
				(project) =>
					!!project.kind &&
					project.kind !== "workspace" &&
					project.kind !== "environment" &&
					project.kind !== "personal",
			),
		},
		{
			id: "shared",
			label: "Shared by others",
			projects: shared,
		},
	];
	return groups.filter((group) => group.projects.length > 0);
}
