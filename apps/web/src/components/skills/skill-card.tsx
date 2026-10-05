"use client";

import { skillCardClasses } from "@clawdi/shared/ui";
import type { SkillCardEntity } from "@clawdi/shared/view";
import {
	agentSurfaceCopy,
	identityFor,
	relativeTime,
	skillSearchSupportingText,
} from "@clawdi/shared/view";
import { Sparkles, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, type EmptyStateVariant } from "@/components/empty-state";
import {
	type EntityCardLinkOptions,
	HERO_GRID_CLASS,
	HeroCard,
	HeroCardSkeleton,
} from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { SearchHighlightedText } from "@/components/search-highlighted-text";
import { SendSkillDialog } from "@/components/skills/send-skill-dialog";
import { SkillRemovalDescription } from "@/components/skills/skill-removal-description";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import type { components } from "@/lib/api-schemas";
import type { SkillCapabilities } from "@/lib/skill-authority";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type SkillLinkBuilder = (skill: SkillSummary) => EntityCardLinkOptions | null;

/* Skills are objects, not spreadsheet rows — they get the same card
 * treatment as projects and vaults: emoji identity tile, name, version,
 * description, quiet meta footer ("why so many list designs?" — Marvin).
 */

export function SkillCard({
	skill,
	cloudSkill,
	readOnly = false,
	readOnlyLabel = agentSurfaceCopy.readOnly,
	showVersion = true,
	actions,
	onUninstall,
	uninstallPending = false,
	sourceLabel,
	provenanceLabel,
	skillLink,
	entityLink,
	searchQuery,
}: {
	skill: SkillCardEntity;
	/** Real Cloud entity backing navigation/selection/Project mutations. */
	cloudSkill?: SkillSummary;
	readOnly?: boolean;
	readOnlyLabel?: string | null;
	showVersion?: boolean;
	actions?: ReactNode;
	onUninstall?: (skillKey: string, projectId: string) => unknown;
	uninstallPending?: boolean;
	/** Provenance chip for cross-project views: where this copy lives. */
	sourceLabel?: { name: string; emoji: string } | null;
	/** Quiet origin metadata; status badges stay short so titles retain priority. */
	provenanceLabel?: string | null;
	/** Build the detail link for the current navigation scope. */
	skillLink?: SkillLinkBuilder;
	/** Navigation for a hosted Skill whose content belongs to the runtime manifest. */
	entityLink?: EntityCardLinkOptions;
	/** Collection-local search context; highlights and explains the matching field. */
	searchQuery?: string;
}) {
	const id = identityFor(skill.name || skill.skill_key);
	const canUninstall = !readOnly && !!onUninstall && !!cloudSkill?.project_id;
	const canSend = !readOnly && !!cloudSkill?.project_id;
	const detailLink =
		entityLink ??
		(!cloudSkill
			? undefined
			: skillLink === undefined
				? {
						to: "/skills/$key" as const,
						params: { key: cloudSkill.skill_key },
						search: cloudSkill.project_id ? { project: cloudSkill.project_id } : undefined,
					}
				: (skillLink(cloudSkill) ?? undefined));
	const cardActions =
		actions || canSend || canUninstall ? (
			<>
				{actions}
				{canSend && cloudSkill ? <SendSkillDialog skill={cloudSkill} /> : null}
				{canUninstall ? (
					<ConfirmAction
						title={`Remove ${skill.name} from Project?`}
						description={<SkillRemovalDescription />}
						confirmLabel="Remove from project"
						destructive
						onConfirm={() => {
							if (!cloudSkill?.project_id) return;
							return onUninstall?.(cloudSkill.skill_key, cloudSkill.project_id);
						}}
					>
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={uninstallPending}
							className={skillCardClasses.removeAction}
							aria-label={`Remove ${skill.name} from Project`}
						>
							<Trash2 className={skillCardClasses.actionIcon} />
						</Button>
					</ConfirmAction>
				) : null}
			</>
		) : undefined;
	return (
		<HeroCard
			className={skillCardClasses.body}
			icon={
				<IconChip size="sm" tint={id.colorClasses} className={skillCardClasses.iconTile}>
					{id.emoji}
				</IconChip>
			}
			title={
				searchQuery ? <SearchHighlightedText text={skill.name} query={searchQuery} /> : skill.name
			}
			badges={
				<>
					{showVersion && skill.version !== undefined ? (
						<Badge variant="outline" className={skillCardClasses.badge}>
							v{skill.version}
						</Badge>
					) : null}
					{readOnly && readOnlyLabel ? (
						<Badge variant="secondary" className={skillCardClasses.badge}>
							{readOnlyLabel}
						</Badge>
					) : null}
				</>
			}
			description={
				searchQuery ? (
					<SearchHighlightedText
						text={skillSearchSupportingText(skill, searchQuery)}
						query={searchQuery}
					/>
				) : (
					skill.description
				)
			}
			footer={[
				provenanceLabel ? <span key="provenance">{provenanceLabel}</span> : null,
				sourceLabel ? (
					<span key="source-label" className={skillCardClasses.projectChip}>
						<span aria-hidden className={skillCardClasses.versionPrefix}>
							{sourceLabel.emoji}
						</span>
						<TruncatedText>{sourceLabel.name}</TruncatedText>
					</span>
				) : null,
				skill.source_repo ? (
					<span key="source" className={skillCardClasses.version} translate="no">
						{skill.source_repo}
					</span>
				) : null,
				skill.updated_at ? relativeTime(skill.updated_at) : null,
			]}
			actions={cardActions}
			link={detailLink}
			ariaLabel={`Open ${skill.name}`}
		/>
	);
}

export function SkillCardSkeleton() {
	return <HeroCardSkeleton compact />;
}

export function SkillCardGrid({
	skills,
	isLoading,
	emptyMessage,
	emptyVariant = "page",
	readOnlySkillCheck,
	capabilitiesFor,
	onUninstall,
	uninstallPending,
	sourceLabelFor,
	skillLink,
	actionsFor,
	showVersionFor,
	searchQuery,
}: {
	skills: SkillSummary[];
	isLoading: boolean;
	emptyMessage: React.ReactNode;
	emptyVariant?: EmptyStateVariant;
	/** Returns true when the current user cannot uninstall this skill. */
	readOnlySkillCheck?: (skill: SkillSummary) => boolean;
	/** Trusted capability projection shared by cards and bulk actions. */
	capabilitiesFor?: (skill: SkillSummary) => SkillCapabilities;
	onUninstall?: (skillKey: string, projectId: string) => unknown;
	uninstallPending?: boolean;
	sourceLabelFor?: (skill: SkillSummary) => { name: string; emoji: string } | null;
	/** Build the detail link for the current navigation scope. */
	skillLink?: SkillLinkBuilder;
	actionsFor?: (skill: SkillSummary) => ReactNode;
	showVersionFor?: (skill: SkillSummary) => boolean;
	searchQuery?: string;
}) {
	if (isLoading) {
		return (
			<div className={HERO_GRID_CLASS}>
				{Array.from({ length: 6 }).map((_, i) => (
					<SkillCardSkeleton key={i} />
				))}
			</div>
		);
	}
	if (skills.length === 0) {
		return <EmptyState variant={emptyVariant} icon={Sparkles} description={emptyMessage} />;
	}
	return (
		<div className={HERO_GRID_CLASS}>
			{skills.map((skill) => {
				const capabilities = capabilitiesFor?.(skill);
				const readOnly = capabilities
					? !capabilities.canUpdate
					: (readOnlySkillCheck?.(skill) ?? false);
				return (
					<SkillCard
						key={skillSelectionKey(skill)}
						skill={skill}
						cloudSkill={skill}
						readOnly={readOnly}
						readOnlyLabel={capabilities?.badgeLabel ?? undefined}
						provenanceLabel={capabilities?.provenanceLabel}
						showVersion={showVersionFor?.(skill) ?? true}
						actions={actionsFor?.(skill)}
						onUninstall={onUninstall}
						uninstallPending={uninstallPending}
						sourceLabel={sourceLabelFor?.(skill) ?? null}
						skillLink={skillLink}
						searchQuery={searchQuery}
					/>
				);
			})}
		</div>
	);
}

function skillSelectionKey(skill: SkillSummary): string {
	return `${skill.project_id ?? "unknown"}:${skill.skill_key}`;
}
