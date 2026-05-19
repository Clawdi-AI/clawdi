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

export function projectOwnerLabel(project: ProjectMetadata) {
	if (isProjectOwner(project)) return "You";
	return project.owner_display ?? project.owner_handle ?? "Unknown";
}

export function projectAccessLabel(project: Pick<ProjectMetadata, "is_owner">) {
	return isProjectOwner(project) ? "Owner" : "Viewer";
}

export function isCustomProject(project: Pick<ProjectMetadata, "kind">): boolean {
	return project.kind === "workspace" || !project.kind;
}

export function isManagedProject(project: Pick<ProjectMetadata, "kind">): boolean {
	return project.kind === "environment" || project.kind === "personal";
}

export function compareProjectsForUse(a: ProjectMetadata, b: ProjectMetadata) {
	const rank = (project: ProjectMetadata) => {
		if (!isProjectOwner(project)) return 3;
		if (project.kind === "workspace") return 0;
		if (project.kind === "personal") return 1;
		if (project.kind === "environment") return 2;
		return 4;
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

export function ProjectIcon({
	project,
	className,
}: {
	project: Pick<ProjectMetadata, "kind">;
	agent?: ProjectAgentMetadata | null;
	className?: string;
}) {
	const meta = projectKindMeta(project.kind ?? "workspace");
	const Icon = meta.icon;
	return (
		<span
			className={cn(
				"mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border",
				meta.iconClassName,
				className,
			)}
			title={meta.label}
		>
			<Icon className="size-3.5" />
		</span>
	);
}

export function ProjectAccessBadge({
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
						"h-auto min-h-10 w-full max-w-full justify-between py-1.5",
						isStacked ? "min-w-0" : "min-w-[240px] sm:w-[360px]",
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

function ProjectPickerValue({
	project,
	agent,
}: {
	project: ProjectMetadata;
	agent?: ProjectAgentMetadata | null;
}) {
	return (
		<span className="flex min-w-0 items-center gap-2 text-left">
			<ProjectIcon project={project} agent={agent} className="mt-0 size-5 rounded-sm" />
			<span className="min-w-0 flex-1">
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium">{displayProjectName(project)}</span>
					<ProjectTypeBadge project={project} compact />
				</span>
				<span className="block truncate font-mono text-xs text-muted-foreground" translate="no">
					{projectAlias(project)}
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
					"flex shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground",
					compact ? "size-5 rounded-sm" : "size-6",
				)}
			>
				<FolderKanban className={compact ? "size-3" : "size-3.5"} />
			</span>
			<span className="min-w-0">
				<span className="block truncate font-medium">{label}</span>
				{compact ? null : (
					<span className="block truncate text-xs text-muted-foreground">{description}</span>
				)}
			</span>
		</span>
	);
}

function ProjectTypeBadge({
	project,
	compact = false,
}: {
	project: ProjectMetadata;
	compact?: boolean;
}) {
	const text =
		project.is_owner === false
			? "Shared"
			: project.kind === "workspace" || !project.kind
				? "Custom"
				: project.kind === "personal"
					? "Global"
					: project.kind === "environment"
						? "Agent"
						: project.kind;
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
			label: "Shared With Me",
			projects: shared,
		},
	];
	return groups.filter((group) => group.projects.length > 0);
}
