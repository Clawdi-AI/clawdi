"use client";

import { Link, type LinkProps } from "@tanstack/react-router";
import { Sparkles, Trash2 } from "lucide-react";
import { EmptyState, type EmptyStateVariant } from "@/components/empty-state";
import { HERO_CARD_BASE } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { SendSkillDialog } from "@/components/skills/send-skill-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { cn, relativeTime } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type SkillLinkOptions = Pick<LinkProps, "to" | "params" | "search" | "hash">;
type SkillLinkBuilder = (skill: SkillSummary) => SkillLinkOptions;

/* Skills are objects, not spreadsheet rows — they get the same card
 * treatment as projects and vaults: emoji identity tile, name, version,
 * description, quiet meta footer ("why so many list designs?" — Marvin).
 *
 * Select mode turns the whole card into a checkbox: curation (batch-move
 * skills out of agent projects into a named Project) is the highest-value
 * job on this page, so selection must be a primary gesture, not a
 * hover-discovered one. */

export function SkillCard({
	skill,
	readOnly = false,
	onUninstall,
	uninstallPending = false,
	selectMode = false,
	selected = false,
	onToggleSelect,
	sourceLabel,
	skillLink,
}: {
	skill: SkillSummary;
	readOnly?: boolean;
	onUninstall?: (skillKey: string, projectId: string) => void;
	uninstallPending?: boolean;
	selectMode?: boolean;
	selected?: boolean;
	onToggleSelect?: (skill: SkillSummary) => void;
	/** Provenance chip for cross-project views: where this copy lives. */
	sourceLabel?: { name: string; emoji: string } | null;
	/** Build the detail link for the current navigation scope. */
	skillLink?: SkillLinkBuilder;
}) {
	const id = identityFor(skill.name || skill.skill_key);
	const canUninstall = !readOnly && !!onUninstall && !!skill.project_id;
	const detailLink = skillLink?.(skill) ?? {
		to: "/skills/$key",
		params: { key: skill.skill_key },
		search: skill.project_id ? { project: skill.project_id } : undefined,
	};
	return (
		<div
			className={cn(
				HERO_CARD_BASE,
				"group relative z-0 flex min-h-28 flex-col gap-2 transition-all duration-150",
				selectMode && selected
					? "border-foreground/40 bg-accent/50"
					: "hover:-translate-y-px hover:border-foreground/20",
			)}
		>
			<div className="flex items-start justify-between gap-2">
				<IconChip size="sm" tint={id.colorClasses} className="rounded-lg text-base">
					{id.emoji}
				</IconChip>
				{selectMode ? (
					<Checkbox
						checked={selected}
						tabIndex={-1}
						aria-hidden
						className="pointer-events-none shrink-0"
					/>
				) : (
					<span className="relative z-10 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
						{skill.project_id ? <SendSkillDialog skills={[skill]} /> : null}
						{canUninstall ? (
							<ConfirmAction
								title={`Uninstall ${skill.name}?`}
								description={<p>Other Projects keep their copies.</p>}
								confirmLabel="Uninstall"
								destructive
								onConfirm={() => {
									if (skill.project_id) onUninstall?.(skill.skill_key, skill.project_id);
								}}
							>
								<Button
									variant="ghost"
									size="icon-sm"
									disabled={uninstallPending}
									className="text-muted-foreground hover:text-destructive"
									aria-label={`Uninstall ${skill.name}`}
								>
									<Trash2 className="size-3.5" />
								</Button>
							</ConfirmAction>
						) : null}
					</span>
				)}
			</div>
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-1.5">
					<h3 className="truncate text-sm font-semibold tracking-tight">{skill.name}</h3>
					<Badge variant="outline" className="shrink-0">
						v{skill.version}
					</Badge>
					{readOnly ? (
						<Badge variant="secondary" className="shrink-0">
							Shared
						</Badge>
					) : null}
				</div>
				{skill.description ? (
					<p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
						{skill.description}
					</p>
				) : null}
			</div>
			<div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
				{sourceLabel ? (
					<span className="inline-flex max-w-44 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5">
						<span aria-hidden className="select-none">
							{sourceLabel.emoji}
						</span>
						<span className="truncate">{sourceLabel.name}</span>
					</span>
				) : null}
				<span className="truncate font-mono" translate="no">
					{skill.source_repo ?? skill.source}
				</span>
				{skill.updated_at ? (
					<span className="shrink-0">{relativeTime(skill.updated_at)}</span>
				) : null}
			</div>
			{selectMode ? (
				<button
					type="button"
					onClick={() => onToggleSelect?.(skill)}
					aria-pressed={selected}
					className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span className="sr-only">
						{selected ? "Deselect" : "Select"} {skill.name}
					</span>
				</button>
			) : (
				<Link
					{...detailLink}
					className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span className="sr-only">Open {skill.name}</span>
				</Link>
			)}
		</div>
	);
}

export function SkillCardGrid({
	skills,
	isLoading,
	emptyMessage,
	emptyVariant = "page",
	readOnlySkillCheck,
	onUninstall,
	uninstallPending,
	selectMode = false,
	selectedKeys,
	onToggleSelect,
	sourceLabelFor,
	skillLink,
}: {
	skills: SkillSummary[];
	isLoading: boolean;
	emptyMessage: React.ReactNode;
	emptyVariant?: EmptyStateVariant;
	/** Returns true when the current user cannot uninstall this skill. */
	readOnlySkillCheck?: (skill: SkillSummary) => boolean;
	onUninstall?: (skillKey: string, projectId: string) => void;
	uninstallPending?: boolean;
	selectMode?: boolean;
	/** Selection identity: `${project_id}:${skill_key}` (see skillSelectionKey). */
	selectedKeys?: Set<string>;
	onToggleSelect?: (skill: SkillSummary) => void;
	sourceLabelFor?: (skill: SkillSummary) => { name: string; emoji: string } | null;
	/** Build the detail link for the current navigation scope. */
	skillLink?: SkillLinkBuilder;
}) {
	if (isLoading) {
		return (
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
		<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
			{skills.map((skill) => (
				<SkillCard
					key={skillSelectionKey(skill)}
					skill={skill}
					readOnly={readOnlySkillCheck?.(skill) ?? false}
					onUninstall={onUninstall}
					uninstallPending={uninstallPending}
					selectMode={selectMode}
					selected={selectedKeys?.has(skillSelectionKey(skill)) ?? false}
					onToggleSelect={onToggleSelect}
					sourceLabel={sourceLabelFor?.(skill) ?? null}
					skillLink={skillLink}
				/>
			))}
		</div>
	);
}

export function skillSelectionKey(skill: SkillSummary): string {
	return `${skill.project_id ?? "unknown"}:${skill.skill_key}`;
}
