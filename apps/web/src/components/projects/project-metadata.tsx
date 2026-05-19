import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface ProjectMetadata {
	id?: string;
	name: string;
	slug: string;
	kind?: string;
	is_owner?: boolean;
	owner_display?: string | null;
	owner_handle?: string | null;
}

export function isProjectOwner(project: Pick<ProjectMetadata, "is_owner">): boolean {
	return project.is_owner !== false;
}

export function displayProjectName(project: Pick<ProjectMetadata, "kind" | "name" | "slug">) {
	if (
		project.kind === "personal" &&
		(project.slug === "personal" || ["default", "personal"].includes(project.name.toLowerCase()))
	) {
		return "Personal";
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
	return isProjectOwner(project) ? "owner" : "viewer";
}

export function compareProjectsForUse(a: ProjectMetadata, b: ProjectMetadata) {
	const rank = (project: ProjectMetadata) => {
		if (!isProjectOwner(project)) return 3;
		if (project.kind === "workspace") return 0;
		if (project.kind === "environment") return 1;
		if (project.kind === "personal") return 2;
		return 4;
	};
	const byRank = rank(a) - rank(b);
	if (byRank !== 0) return byRank;
	return displayProjectName(a).localeCompare(displayProjectName(b));
}

export function ProjectIdentity({
	project,
	className,
	badges,
	showKind = true,
	showOwner = true,
	showAccess = true,
	showAlias = true,
	titleClassName,
}: {
	project: ProjectMetadata;
	className?: string;
	badges?: ReactNode;
	showKind?: boolean;
	showOwner?: boolean;
	showAccess?: boolean;
	showAlias?: boolean;
	titleClassName?: string;
}) {
	return (
		<div className={cn("min-w-0", className)}>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<span className={cn("min-w-0 max-w-full truncate text-sm font-semibold", titleClassName)}>
					{displayProjectName(project)}
				</span>
				{badges}
				{showAccess ? <ProjectAccessBadge project={project} /> : null}
				{showKind && project.kind ? <ProjectKindBadge kind={project.kind} /> : null}
			</div>
			{showAlias || showOwner || showAccess ? (
				<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
					{showAlias ? (
						<span className="min-w-0 truncate font-mono" translate="no">
							{projectAlias(project)}
						</span>
					) : null}
					{showOwner ? <span className="truncate">Owner: {projectOwnerLabel(project)}</span> : null}
					{showAccess ? <span>Access: {projectAccessLabel(project)}</span> : null}
				</div>
			) : null}
		</div>
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
		<Badge variant={owner ? "outline" : "secondary"} className={cn("text-xs", className)}>
			{owner ? "owner" : "viewer"}
		</Badge>
	);
}

export function ProjectKindBadge({ kind, className }: { kind: string; className?: string }) {
	const meta = projectKindMeta(kind);
	return (
		<Badge
			variant={kind === "personal" ? "outline" : "secondary"}
			className={cn("text-xs", className)}
			title={meta.description}
		>
			{meta.label}
		</Badge>
	);
}

export function ProjectScopePicker({
	projects,
	value,
	onValueChange,
	label = "Project",
	placeholder = "Choose project…",
	allowAll = false,
	allLabel = "All projects",
	disabled,
}: {
	projects: ProjectMetadata[];
	value: string;
	onValueChange: (value: string) => void;
	label?: string;
	placeholder?: string;
	allowAll?: boolean;
	allLabel?: string;
	disabled?: boolean;
}) {
	const selectedProject = projects.find((project) => project.id === value) ?? null;
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-3 text-sm">
			<span className="text-muted-foreground">{label}</span>
			<Select value={value} onValueChange={onValueChange} disabled={disabled}>
				<SelectTrigger
					aria-label={label}
					className="h-auto min-h-9 w-full min-w-[260px] max-w-full justify-between py-2 sm:w-[360px]"
				>
					{selectedProject ? (
						<ProjectIdentity
							project={selectedProject}
							showKind={false}
							showOwner={false}
							showAccess={false}
							titleClassName="text-sm"
							className="text-left"
						/>
					) : value === "all" && allowAll ? (
						<span>{allLabel}</span>
					) : (
						<SelectValue placeholder={placeholder} />
					)}
				</SelectTrigger>
				<SelectContent
					position="popper"
					align="start"
					className="w-[var(--radix-select-trigger-width)]"
				>
					<SelectGroup>
						{allowAll ? <SelectItem value="all">{allLabel}</SelectItem> : null}
						{projects.map((project) =>
							project.id ? (
								<SelectItem key={project.id} value={project.id} className="py-2">
									<ProjectIdentity project={project} showKind={false} />
								</SelectItem>
							) : null,
						)}
					</SelectGroup>
				</SelectContent>
			</Select>
		</div>
	);
}

export function projectKindMeta(kind: string) {
	if (kind === "workspace") {
		return {
			label: "Project",
			description: "Shared Project for a team or workflow.",
		};
	}
	if (kind === "environment") {
		return {
			label: "Environment",
			description: "Project created by an agent environment.",
		};
	}
	if (kind === "personal") {
		return {
			label: "Personal",
			description: "Personal default project.",
		};
	}
	return { label: kind, description: `Project type: ${kind}` };
}
