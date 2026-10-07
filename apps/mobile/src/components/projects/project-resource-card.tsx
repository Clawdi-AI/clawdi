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
import { type EntityCardLinkOptions, HeroCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";
import { webBoth } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
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
	const t = useI18n();
	const name = displayProjectName(project),
		identity = identityFor(name);
	return (
		<HeroCard
			testID={project.id ? `project-card-${project.id}` : undefined}
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
						<Text>{t("projects.viewer")}</Text>
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
					? { to: { pathname: "/projects/[id]", params: { id: project.id } } }
					: undefined)
			}
			ariaLabel={t("labels.openItem", { name: name })}
		/>
	);
}
