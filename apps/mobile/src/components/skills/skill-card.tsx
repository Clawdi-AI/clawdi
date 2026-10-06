import { skillCardClasses } from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	identityFor,
	relativeTime,
	type SkillCardEntity,
	skillSearchSupportingText,
} from "@clawdi/shared/view";
import type { ReactNode } from "react";
import { type EntityCardLinkOptions, HeroCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";
import { webBoth, webView } from "@/components/ui/web-layout";
export function SkillCard({
	skill,
	link,
	searchQuery,
	actions,
	readOnly = false,
	provenanceLabel,
}: {
	skill: SkillCardEntity;
	link?: EntityCardLinkOptions;
	searchQuery?: string;
	actions?: ReactNode;
	readOnly?: boolean;
	provenanceLabel?: string;
}) {
	const identity = identityFor(skill.name || skill.skill_key);
	return (
		<HeroCard
			className={webView(skillCardClasses.body)}
			icon={
				<IconChip
					size="sm"
					tint={identity.colorClasses}
					className={webBoth(skillCardClasses.iconTile)}
				>
					{identity.emoji}
				</IconChip>
			}
			title={skill.name}
			badges={
				<>
					{skill.version !== undefined ? (
						<Badge variant="outline" className={webView(skillCardClasses.badge)}>
							<Text>v{skill.version}</Text>
						</Badge>
					) : null}
					{readOnly ? (
						<Badge variant="secondary" className={webView(skillCardClasses.badge)}>
							<Text>{agentSurfaceCopy.readOnly}</Text>
						</Badge>
					) : null}
				</>
			}
			description={searchQuery ? skillSearchSupportingText(skill, searchQuery) : skill.description}
			footer={[
				provenanceLabel,
				skill.source_repo ? (
					<Text key="source" className={webBoth(skillCardClasses.version)}>
						{skill.source_repo}
					</Text>
				) : null,
				skill.updated_at ? relativeTime(skill.updated_at) : null,
			]}
			link={link}
			actions={actions}
			ariaLabel={`Open ${skill.name}`}
		/>
	);
}
