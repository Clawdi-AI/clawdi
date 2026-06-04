"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { SendSkillDialog } from "@/components/skills/send-skill-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { skillDetailHref } from "@/lib/project-resource-model";
import { cn, relativeTime } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

/* Skills are objects, not spreadsheet rows — they get the same card
 * treatment as projects and vaults: emoji identity tile, name, version,
 * description, quiet meta footer ("why so many list designs?" — Marvin). */

export function SkillCard({
	skill,
	readOnly = false,
	onUninstall,
	uninstallPending = false,
}: {
	skill: SkillSummary;
	readOnly?: boolean;
	onUninstall?: (skillKey: string, projectId: string) => void;
	uninstallPending?: boolean;
}) {
	const id = identityFor(skill.name || skill.skill_key);
	const canUninstall = !readOnly && !!onUninstall && !!skill.project_id;
	return (
		<div className="group relative z-0 flex min-h-28 flex-col gap-2 rounded-xl border bg-card p-4 transition-all duration-150 hover:-translate-y-px hover:border-foreground/20">
			<div className="flex items-start justify-between gap-2">
				<span
					className={cn(
						"flex size-8 shrink-0 select-none items-center justify-center rounded-lg text-base leading-none",
						id.colorClasses,
					)}
				>
					{id.emoji}
				</span>
				<span className="relative z-10 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
					{skill.project_id ? <SendSkillDialog skill={skill} /> : null}
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
				<span className="truncate font-mono" translate="no">
					{skill.source_repo ?? skill.source}
				</span>
				{skill.updated_at ? (
					<span className="shrink-0">{relativeTime(skill.updated_at)}</span>
				) : null}
			</div>
			<Link
				href={skillDetailHref(skill.skill_key, skill.project_id)}
				className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="sr-only">Open {skill.name}</span>
			</Link>
		</div>
	);
}

export function SkillCardGrid({
	skills,
	isLoading,
	emptyMessage,
	readOnlySkillCheck,
	onUninstall,
	uninstallPending,
}: {
	skills: SkillSummary[];
	isLoading: boolean;
	emptyMessage: React.ReactNode;
	/** Returns true when the current user cannot uninstall this skill. */
	readOnlySkillCheck?: (skill: SkillSummary) => boolean;
	onUninstall?: (skillKey: string, projectId: string) => void;
	uninstallPending?: boolean;
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
		return (
			<div className="rounded-xl border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
				{emptyMessage}
			</div>
		);
	}
	return (
		<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
			{skills.map((skill) => (
				<SkillCard
					key={`${skill.project_id ?? "unknown"}-${skill.skill_key}`}
					skill={skill}
					readOnly={readOnlySkillCheck?.(skill) ?? false}
					onUninstall={onUninstall}
					uninstallPending={uninstallPending}
				/>
			))}
		</div>
	);
}
