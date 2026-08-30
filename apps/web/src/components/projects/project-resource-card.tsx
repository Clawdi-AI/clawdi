import { FolderKanban } from "lucide-react";
import type { ReactNode } from "react";
import { type EntityCardLinkOptions, HeroCard, HeroCardSkeleton } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import {
	displayProjectName,
	isProjectOwner,
	ProjectKindBadge,
	type ProjectMetadata,
	projectSearchSupportingText,
	projectSupportingText,
} from "@/components/projects/project-metadata";
import { SearchHighlightedText } from "@/components/search-highlighted-text";
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
	searchQuery,
	className,
}: {
	project: ProjectMetadata;
	footer?: ReactNode | ReactNode[];
	actions?: ReactNode;
	showKind?: boolean;
	navigationScope?: ResourceNavigationScope;
	/** Optional collection-local destination while retaining the canonical card. */
	link?: EntityCardLinkOptions;
	/** Collection-local search context; highlights and explains the matching field. */
	searchQuery?: string;
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
			title={
				searchQuery ? <SearchHighlightedText text={projectName} query={searchQuery} /> : projectName
			}
			badges={
				showKind || showViewer ? (
					<>
						{showKind ? <ProjectKindBadge kind={project.kind ?? "workspace"} /> : null}
						{showViewer ? <Badge variant="outline">Viewer</Badge> : null}
					</>
				) : undefined
			}
			description={
				searchQuery ? (
					<SearchHighlightedText
						text={projectSearchSupportingText(project, searchQuery)}
						query={searchQuery}
					/>
				) : (
					projectSupportingText(project)
				)
			}
			footer={footer}
			actions={actions}
			link={detailLink}
			ariaLabel={`Open ${projectName}`}
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
		/>
	);
}

export function ProjectResourceCardSkeleton() {
	return <HeroCardSkeleton />;
}
