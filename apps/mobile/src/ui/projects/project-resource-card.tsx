import { projectResourceCardClasses } from "@clawdi/shared/ui";
import {
	displayProjectName,
	identityFor,
	isProjectOwner,
	type ProjectMetadata,
	projectSearchSupportingText,
	projectSupportingText,
} from "@clawdi/shared/view";
import type { ReactNode } from "react";
import { Badge } from "../badge";
import { type EntityCardLinkOptions, HeroCard } from "../entity-card";
import { IconChip } from "../icon-chip";
import { Text } from "../text";
import { webBoth } from "../web-layout";
export function ProjectResourceCard({
	project,
	footer,
	actions,
	link,
	searchQuery,
}: {
	project: ProjectMetadata;
	footer?: ReactNode[];
	actions?: ReactNode;
	link?: EntityCardLinkOptions;
	searchQuery?: string;
}) {
	const name = displayProjectName(project),
		identity = identityFor(name);
	return (
		<HeroCard
			icon={
				<IconChip
					tint={identity.colorClasses}
					className={webBoth(projectResourceCardClasses.emoji)}
				>
					{identity.emoji}
				</IconChip>
			}
			title={name}
			badges={
				!isProjectOwner(project) ? (
					<Badge variant="outline">
						<Text>Viewer</Text>
					</Badge>
				) : undefined
			}
			description={
				searchQuery
					? projectSearchSupportingText(project, searchQuery)
					: projectSupportingText(project)
			}
			footer={footer}
			actions={actions}
			actionsVisibility="always"
			link={
				link ??
				(project.id
					? { to: { pathname: "/projects/[projectId]", params: { projectId: project.id } } }
					: undefined)
			}
			ariaLabel={`Open ${name}`}
		/>
	);
}
