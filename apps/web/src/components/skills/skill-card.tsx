"use client";

import type { LinkProps } from "@tanstack/react-router";
import { Sparkles, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, type EmptyStateVariant } from "@/components/empty-state";
import { HERO_GRID_CLASS, HeroCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { SendSkillDialog } from "@/components/skills/send-skill-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import type { SkillCapabilities } from "@/lib/skill-authority";
import { relativeTime } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
export type SkillCardEntity = Pick<SkillSummary, "skill_key" | "name" | "description"> &
	Partial<Pick<SkillSummary, "source" | "source_repo" | "version" | "updated_at">>;
type SkillLinkOptions = Pick<LinkProps, "to" | "params" | "search" | "hash">;
type SkillLinkBuilder = (skill: SkillSummary) => SkillLinkOptions | null;

/* Skills are objects, not spreadsheet rows — they get the same card
 * treatment as projects and vaults: emoji identity tile, name, version,
 * description, quiet meta footer ("why so many list designs?" — Marvin).
 */

export function SkillCard({
	skill,
	cloudSkill,
	readOnly = false,
	readOnlyLabel = "Shared · Read-only",
	showVersion = true,
	actions,
	onUninstall,
	uninstallPending = false,
	sourceLabel,
	skillLink,
}: {
	skill: SkillCardEntity;
	/** Real Cloud entity backing navigation/selection/Project mutations. */
	cloudSkill?: SkillSummary;
	readOnly?: boolean;
	readOnlyLabel?: string | null;
	showVersion?: boolean;
	actions?: ReactNode;
	onUninstall?: (skillKey: string, projectId: string) => void;
	uninstallPending?: boolean;
	/** Provenance chip for cross-project views: where this copy lives. */
	sourceLabel?: { name: string; emoji: string } | null;
	/** Build the detail link for the current navigation scope. */
	skillLink?: SkillLinkBuilder;
}) {
	const id = identityFor(skill.name || skill.skill_key);
	const canUninstall = !readOnly && !!onUninstall && !!cloudSkill?.project_id;
	const canSend = !readOnly && !!cloudSkill?.project_id;
	const detailLink = !cloudSkill
		? undefined
		: skillLink === undefined
			? {
					to: "/skills/$key" as const,
					params: { key: cloudSkill.skill_key },
					search: cloudSkill.project_id ? { project: cloudSkill.project_id } : undefined,
				}
			: (skillLink(cloudSkill) ?? undefined);
	return (
		<HeroCard
			className="min-h-28 gap-2"
			interactive={Boolean(detailLink)}
			icon={
				<IconChip size="sm" tint={id.colorClasses} className="rounded-lg text-base">
					{id.emoji}
				</IconChip>
			}
			title={skill.name}
			badges={
				<>
					{showVersion && skill.version !== undefined ? (
						<Badge variant="outline" className="shrink-0">
							v{skill.version}
						</Badge>
					) : null}
					{readOnly && readOnlyLabel ? (
						<Badge variant="secondary" className="shrink-0">
							{readOnlyLabel}
						</Badge>
					) : null}
				</>
			}
			description={skill.description}
			footer={[
				sourceLabel ? (
					<span
						key="source-label"
						className="inline-flex max-w-44 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5"
					>
						<span aria-hidden className="select-none">
							{sourceLabel.emoji}
						</span>
						<span className="truncate">{sourceLabel.name}</span>
					</span>
				) : null,
				skill.source_repo ? (
					<span key="source" className="font-mono" translate="no">
						{skill.source_repo}
					</span>
				) : null,
				skill.updated_at ? relativeTime(skill.updated_at) : null,
			]}
			actions={
				<div className="flex items-center gap-0.5 opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
					{actions}
					{canSend && cloudSkill ? <SendSkillDialog skill={cloudSkill} /> : null}
					{canUninstall ? (
						<ConfirmAction
							title={`Remove ${skill.name} from Project?`}
							description={<p>Other Projects keep their copies.</p>}
							confirmLabel="Remove from project"
							destructive
							onConfirm={() => {
								if (cloudSkill?.project_id) {
									onUninstall?.(cloudSkill.skill_key, cloudSkill.project_id);
								}
							}}
						>
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={uninstallPending}
								className="text-muted-foreground hover:text-destructive"
								aria-label={`Remove ${skill.name} from Project`}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</ConfirmAction>
					) : null}
				</div>
			}
			link={detailLink}
			ariaLabel={`Open ${skill.name}`}
		/>
	);
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
}: {
	skills: SkillSummary[];
	isLoading: boolean;
	emptyMessage: React.ReactNode;
	emptyVariant?: EmptyStateVariant;
	/** Returns true when the current user cannot uninstall this skill. */
	readOnlySkillCheck?: (skill: SkillSummary) => boolean;
	/** Trusted capability projection shared by cards and bulk actions. */
	capabilitiesFor?: (skill: SkillSummary) => SkillCapabilities;
	onUninstall?: (skillKey: string, projectId: string) => void;
	uninstallPending?: boolean;
	sourceLabelFor?: (skill: SkillSummary) => { name: string; emoji: string } | null;
	/** Build the detail link for the current navigation scope. */
	skillLink?: SkillLinkBuilder;
	actionsFor?: (skill: SkillSummary) => ReactNode;
	showVersionFor?: (skill: SkillSummary) => boolean;
}) {
	if (isLoading) {
		return (
			<div className={HERO_GRID_CLASS}>
				{Array.from({ length: 6 }).map((_, i) => (
					<Skeleton key={i} className="h-28 w-full rounded-xl" />
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
						showVersion={showVersionFor?.(skill) ?? true}
						actions={actionsFor?.(skill)}
						onUninstall={onUninstall}
						uninstallPending={uninstallPending}
						sourceLabel={sourceLabelFor?.(skill) ?? null}
						skillLink={skillLink}
					/>
				);
			})}
		</div>
	);
}

function skillSelectionKey(skill: SkillSummary): string {
	return `${skill.project_id ?? "unknown"}:${skill.skill_key}`;
}
