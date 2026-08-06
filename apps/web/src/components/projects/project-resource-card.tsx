import { FolderKanban } from "lucide-react";
import type { ReactNode } from "react";
import { type EntityCardLinkOptions, HeroCard, HeroCardSkeleton } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import {
	displayProjectName,
	isProjectOwner,
	ProjectKindBadge,
	type ProjectMetadata,
	projectSupportingText,
} from "@/components/projects/project-metadata";
import { Badge } from "@/components/ui/badge";
import { identityFor } from "@/lib/identity";
import {
	LIBRARY_RESOURCE_SCOPE,
	projectDetailLink,
	type ResourceNavigationScope,
} from "@/lib/resource-navigation";

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
	link?: EntityCardLinkOptions;
	className?: string;
}) {
	const projectName = displayProjectName(project);
	const identity = identityFor(projectName);
	const showViewer = !isProjectOwner(project);
	const detailLink =
		link ?? (project.id ? projectDetailLink(navigationScope, project.id) : undefined);
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
			footer={footer}
			actions={actions}
			link={detailLink}
			ariaLabel={`Open ${projectName}`}
			interactive={Boolean(detailLink)}
			className={className}
		/>
	);
}

export function UnavailableProjectResourceCard({
	footer,
	actions,
}: {
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
			title="Unavailable Project"
			badges={<Badge variant="outline">Access unavailable</Badge>}
			footer={footer}
			actions={actions}
			interactive={false}
		/>
	);
}

export function ProjectResourceCardSkeleton() {
	return <HeroCardSkeleton />;
}
