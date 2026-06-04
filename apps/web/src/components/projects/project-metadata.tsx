import { Bot, FolderKanban, Globe2, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { agentTypeLabel, cleanMachineName } from "@/components/dashboard/agent-label";
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
import { cn } from "@/lib/utils";

export interface ProjectMetadata {
	id?: string;
	name: string;
	slug: string;
	kind?: string;
	origin_environment_id?: string | null;
	is_owner?: boolean;
	owner_display?: string | null;
	owner_handle?: string | null;
}

export interface ProjectAgentMetadata {
	id: string;
	machine_name?: string | null;
	agent_type?: string | null;
}

export function isProjectOwner(project: Pick<ProjectMetadata, "is_owner">): boolean {
	return project.is_owner !== false;
}

export function displayProjectName(project: Pick<ProjectMetadata, "kind" | "name" | "slug">) {
	if (
		project.kind === "personal" &&
		(project.slug === "personal" || ["default", "personal"].includes(project.name.toLowerCase()))
	) {
		return "Global";
	}
	return project.name;
}

export function projectAlias(project: Pick<ProjectMetadata, "slug" | "is_owner" | "owner_handle">) {
	return !isProjectOwner(project) && project.owner_handle
		? `@${project.owner_handle}/${project.slug}`
		: project.slug;
}

function projectOwnerLabel(project: ProjectMetadata) {
	if (isProjectOwner(project)) return "You";
	return project.owner_display ?? project.owner_handle ?? "Unknown";
}

export function isCustomProject(project: Pick<ProjectMetadata, "kind">): boolean {
	return project.kind === "workspace" || !project.kind;
}

export function isManagedProject(project: Pick<ProjectMetadata, "kind">): boolean {
	return project.kind === "environment" || project.kind === "personal";
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
	showOwner = true,
	showAccess = true,
	showAlias = true,
	showAgent = true,
	showIcon = true,
	titleClassName,
}: {
	project: ProjectMetadata;
	agent?: ProjectAgentMetadata | null;
	className?: string;
	badges?: ReactNode;
	showKind?: boolean;
	showOwner?: boolean;
	showAccess?: boolean;
	showAlias?: boolean;
	showAgent?: boolean;
	showIcon?: boolean;
	titleClassName?: string;
}) {
	const projectAgent = showAgent && project.kind === "environment" ? agent : null;
	const showOwnerLine = showOwner && !isProjectOwner(project);
	const agentLine = projectAgent ? projectAgentLabel(projectAgent) : null;
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
				{showAlias || showOwnerLine || projectAgent ? (
					<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						{showAlias ? (
							<span className="min-w-0 truncate font-mono" translate="no">
								{projectAlias(project)}
							</span>
						) : null}
						{showOwnerLine ? (
							<span className="truncate">Owner: {projectOwnerLabel(project)}</span>
						) : null}
						{agentLine ? (
							<span className="min-w-0 truncate" translate="no">
								Agent: {agentLine}
							</span>
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
				"mt-0.5 flex size-6 shrink-0 select-none items-center justify-center rounded-md text-[13px] leading-none",
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
	const selectedProject = projects.find((project) => project.id === value) ?? null;
	const agentsById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
	const selectedAgent = selectedProject ? projectAgentFor(selectedProject, agentsById) : null;
	const groupedProjects = projectPickerGroups(projects);
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
			<Select value={value} onValueChange={onValueChange} disabled={disabled}>
				<SelectTrigger
					aria-label={label}
					className={cn(
						"h-auto min-h-16 w-full max-w-full justify-between rounded-[10px] border-border/80 bg-background/70 px-3 py-2.5 whitespace-normal shadow-xs transition-colors hover:bg-muted/20",
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
					position="popper"
					align="start"
					className="w-[var(--radix-select-trigger-width)] min-w-[min(420px,calc(100vw-2rem))]"
				>
					{allowAll ? (
						<SelectItem value="all" className="py-2">
							<ProjectPickerAllItem label={allLabel} description={allDescription} />
						</SelectItem>
					) : null}
					{allowAll && groupedProjects.length > 0 ? <SelectSeparator /> : null}
					{groupedProjects.map((group, groupIndex) => (
						<SelectGroup key={group.id}>
							<SelectLabel className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide">
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
	const selectedProject = projects.find((project) => project.id === value) ?? null;
	const agentsById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
	return (
		<Select value={value} onValueChange={onValueChange} disabled={disabled}>
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
						<span className="min-w-0 truncate font-medium">
							{displayProjectName(selectedProject)}
						</span>
						<span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
							{projectCompactKindText(selectedProject)}
						</span>
					</span>
				) : value === "all" && allowAll ? (
					<span className="flex min-w-0 items-center gap-2 text-left">
						<span className="flex size-5 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
							<FolderKanban className="size-3" />
						</span>
						<span className="truncate font-medium">{allLabel}</span>
					</span>
				) : (
					<SelectValue placeholder={placeholder} />
				)}
			</SelectTrigger>
			<SelectContent
				position="popper"
				align="start"
				className="w-[var(--radix-select-trigger-width)] min-w-[min(420px,calc(100vw-2rem))]"
			>
				{allowAll ? (
					<SelectItem value="all" className="py-2">
						<div className="flex min-w-0 items-center gap-2">
							<span className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
								<FolderKanban className="size-3.5" />
							</span>
							<div className="min-w-0">
								<div className="truncate font-medium">{allLabel}</div>
								<div className="truncate text-xs text-muted-foreground">{allDescription}</div>
							</div>
						</div>
					</SelectItem>
				) : null}
				{allowAll && projects.length > 0 ? <SelectSeparator /> : null}
				{projects.map((project) =>
					project.id ? (
						<SelectItem key={project.id} value={project.id} className="py-2">
							<ProjectIdentity
								project={project}
								agent={projectAgentFor(project, agentsById)}
								showOwner={false}
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
			<ProjectIcon project={project} agent={agent} className="mt-0 size-7 rounded-[8px]" />
			<span className="grid min-w-0 flex-1 gap-0.5">
				<span className="truncate text-[15px] leading-5 font-semibold">
					{displayProjectName(project)}
				</span>
				<span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
					<span className="shrink-0">{projectPickerTypeText(project)}</span>
					<span aria-hidden="true" className="text-muted-foreground/60">
						·
					</span>
					<span className="min-w-0 truncate font-mono" translate="no">
						{projectAlias(project)}
					</span>
				</span>
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
					<span className="truncate font-medium">{displayProjectName(project)}</span>
					<ProjectTypeBadge project={project} />
				</div>
				<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
					<span className="min-w-0 truncate font-mono" translate="no">
						{projectAlias(project)}
					</span>
					<span className="shrink-0">·</span>
					<span className="shrink-0">{projectPickerAccessText(project)}</span>
					{project.kind === "environment" && agent ? (
						<>
							<span className="shrink-0">·</span>
							<span className="min-w-0 truncate" translate="no">
								{projectAgentLabel(agent)}
							</span>
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
					"flex shrink-0 items-center justify-center rounded-[8px] border bg-muted/40 text-muted-foreground",
					compact ? "size-7" : "size-6",
				)}
			>
				<FolderKanban className={compact ? "size-3.5" : "size-3.5"} />
			</span>
			<span className={cn("min-w-0", compact && "grid gap-0.5")}>
				<span className={cn("block truncate font-medium", compact && "text-[15px] leading-5")}>
					{label}
				</span>
				<span className="block truncate text-xs text-muted-foreground">{description}</span>
			</span>
		</span>
	);
}

function projectPickerTypeText(project: ProjectMetadata) {
	if (project.is_owner === false) return "Shared Project";
	return ownedProjectKindText(project, "full");
}

function projectCompactKindText(project: ProjectMetadata) {
	if (project.is_owner === false) return "Shared";
	return ownedProjectKindText(project, "compact");
}

function ownedProjectKindText(
	project: Pick<ProjectMetadata, "kind">,
	variant: "full" | "compact" | "badge",
) {
	if (project.kind === "workspace" || !project.kind) {
		return variant === "full" ? "Custom Project" : "Custom";
	}
	if (project.kind === "personal") return variant === "full" ? "Global Project" : "Global";
	if (project.kind === "environment") return variant === "full" ? "Agent Project" : "Agent";
	if (variant === "badge" && project.kind) return project.kind;
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
				"shrink-0 border-border/70 px-1.5 py-0 text-[11px] font-normal text-muted-foreground",
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
	return "Managed";
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
			label: "Custom Project",
			groupLabel: "Custom Projects",
			description: "Project you create for a workflow, team, or shareable resources.",
			icon: FolderKanban,
			iconClassName: "border-border bg-muted/50 text-muted-foreground",
			badgeClassName: "border-border bg-muted/50 text-muted-foreground",
		};
	}
	if (kind === "environment") {
		return {
			label: "Agent Project",
			groupLabel: "Managed Projects",
			description: "Agent Project managed for one connected agent.",
			icon: Bot,
			iconClassName: "border-border bg-muted/50 text-muted-foreground",
			badgeClassName: "border-border bg-muted/50 text-muted-foreground",
		};
	}
	if (kind === "personal") {
		return {
			label: "Global Project",
			groupLabel: "Managed Projects",
			description: "Account-wide default Project for resources not tied to one agent or workflow.",
			icon: Globe2,
			iconClassName: "border-border bg-muted/50 text-muted-foreground",
			badgeClassName: "border-border bg-muted/50 text-muted-foreground",
		};
	}
	return {
		label: kind,
		groupLabel: "Other Projects",
		description: `Project type: ${kind}`,
		icon: FolderKanban,
		iconClassName: "border-border bg-muted/40 text-muted-foreground",
		badgeClassName: "border-border bg-muted/40 text-muted-foreground",
	};
}

function projectAgentLabel(agent: ProjectAgentMetadata) {
	const name = cleanMachineName(agent.machine_name) || "Agent";
	const type = agent.agent_type ? agentTypeLabel(agent.agent_type) : null;
	return type && type !== name ? `${name} · ${type}` : name;
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
			id: "custom",
			label: "Custom Projects",
			projects: owned.filter(isCustomProject),
		},
		{
			id: "managed",
			label: "Managed Projects",
			projects: owned.filter(isManagedProject),
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
