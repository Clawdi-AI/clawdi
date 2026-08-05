import type { LinkProps } from "@tanstack/react-router";
import { FolderKanban } from "lucide-react";
import type { ReactNode } from "react";
import { HERO_CARD_BASE, HeroCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import {
	displayProjectName,
	isProjectOwner,
	ProjectKindBadge,
	type ProjectMetadata,
	projectSupportingText,
} from "@/components/projects/project-metadata";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { identityFor } from "@/lib/identity";
import {
	LIBRARY_RESOURCE_SCOPE,
	projectDetailLink,
	type ResourceNavigationScope,
} from "@/lib/resource-navigation";
import { cn } from "@/lib/utils";

/**
 * Canonical Project card. Collection surfaces supply only their contextual
 * metadata and actions; Project identity, access language, and navigation stay
 * identical everywhere.
 */
export function ProjectResourceCard({
	project,
	footer,
	actions,
	showKind = false,
	navigationScope = LIBRARY_RESOURCE_SCOPE,
	link,
	className,
}: {
	project: ProjectMetadata;
	footer?: ReactNode | ReactNode[];
	actions?: ReactNode;
	showKind?: boolean;
	navigationScope?: ResourceNavigationScope;
	/** Optional collection-local destination while retaining the canonical card. */
	link?: Pick<LinkProps, "to" | "params" | "search" | "hash">;
	className?: string;
}) {
	const projectName = displayProjectName(project);
	const identity = identityFor(projectName);
	const showViewer = !isProjectOwner(project);
	return (
		<HeroCard
			icon={
				<IconChip tint={identity.colorClasses} className="text-xl">
					{identity.emoji}
				</IconChip>
			}
			title={projectName}
			badges={
				showKind || showViewer ? (
					<>
						{showKind ? <ProjectKindBadge kind={project.kind ?? "workspace"} /> : null}
						{showViewer ? <Badge variant="outline">Viewer</Badge> : null}
					</>
				) : undefined
			}
			description={projectSupportingText(project)}
			descriptionClassName="truncate"
			footer={footer}
			actions={actions}
			link={link ?? (project.id ? projectDetailLink(navigationScope, project.id) : undefined)}
			ariaLabel={`Open ${projectName}`}
			className={className}
		/>
	);
}

export function UnavailableProjectResourceCard({
	projectId,
	footer,
	actions,
}: {
	projectId: string;
	footer?: ReactNode | ReactNode[];
	actions?: ReactNode;
}) {
	return (
		<HeroCard
			icon={
				<IconChip tint="bg-muted text-muted-foreground">
					<FolderKanban />
				</IconChip>
			}
			title={projectId}
			badges={<Badge variant="outline">Access unavailable</Badge>}
			footer={footer}
			actions={actions}
			interactive={false}
		/>
	);
}

export function ProjectResourceCardSkeleton() {
	return (
		<div className={cn(HERO_CARD_BASE, "flex min-h-36 flex-col gap-3")}>
			<Skeleton className="size-10 rounded-lg" />
			<div className="min-w-0 space-y-2">
				<Skeleton className="h-5 w-44 max-w-full" />
				<Skeleton className="h-3 w-32" />
			</div>
			<div className="mt-auto flex items-center gap-3">
				<Skeleton className="h-3 w-16" />
				<Skeleton className="h-3 w-16" />
			</div>
		</div>
	);
}
