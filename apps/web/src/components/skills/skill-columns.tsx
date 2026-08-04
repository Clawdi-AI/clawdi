"use client";

import type { components } from "@clawdi/shared/api";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { skillCapabilities } from "@/lib/skill-authority";
import { relativeTime } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type Project = components["schemas"]["ProjectResponse"];
type ProjectCapabilityMetadata = Pick<Project, "kind" | "is_owner">;

// Mirrors `session-columns.tsx` and `memory-columns.tsx`: a TanStack
// `ColumnDef` array shared by the agent detail page's Skills tab and
// any future skill list surface. Bespoke per-row Cards are gone — every
// listy resource on the dashboard now goes through `<DataTable>` with
// its own column factory.
//
// `makeSkillColumns` takes an uninstall handler so the caller owns the
// mutation; the column defs only know how to render and which row to
// pass to the callback.
//
// Persisted authority plus Project kind is the ownership boundary.
// Agent filesystem projections and every environment-kind Project row
// remain read-only even when the current user owns the Project.
export type SkillProjectAccess = "writable" | "read-only" | "unknown";

export interface SkillColumnOptions {
	projectsById?: ReadonlyMap<string, ProjectCapabilityMetadata> | null;
}

export function resolveSkillProjectAccess(
	skill: Pick<SkillSummary, "authority" | "project_id" | "project_kind">,
	options: SkillColumnOptions = {},
): SkillProjectAccess {
	if (!skill.project_id) return "unknown";
	if (!options.projectsById) return "unknown";
	return skillCapabilities(skill, options.projectsById.get(skill.project_id)).canUpdate
		? "writable"
		: "read-only";
}

export function makeSkillColumns(
	onUninstall: (skillKey: string, projectId: string) => void,
	uninstallPending: boolean,
	options: SkillColumnOptions = {},
): ColumnDef<SkillSummary>[] {
	return [
		{
			id: "name",
			accessorKey: "name",
			enableSorting: false,
			header: () => <span className="text-sm font-medium">Skill</span>,
			cell: ({ row }) => {
				const s = row.original;
				const sourceProjectName = s.project_name ?? null;
				const access = resolveSkillProjectAccess(s, options);
				return (
					<div className="flex min-w-0 items-start gap-2">
						<Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
						<div className="min-w-0 flex-1 space-y-0.5">
							<div className="flex min-w-0 items-center gap-2">
								<Link
									to="/skills/$key"
									params={{ key: s.skill_key }}
									search={s.project_id ? { project: s.project_id } : undefined}
									onClick={(e) => e.stopPropagation()}
									className="truncate text-sm font-medium hover:underline"
								>
									{s.name}
								</Link>
								<Badge variant="outline" className="shrink-0">
									v{s.version}
								</Badge>
								{access === "read-only" ? (
									<Badge
										variant="secondary"
										className="shrink-0"
										title={
											sourceProjectName
												? `Read-only Skill in "${sourceProjectName}".`
												: "Read-only Skill."
										}
									>
										{skillCapabilities(
											s,
											s.project_id ? options.projectsById?.get(s.project_id) : undefined,
										).badgeLabel ?? "Read-only"}
									</Badge>
								) : null}
							</div>
							{s.description ? (
								<p className="max-w-[240px] truncate text-xs text-muted-foreground sm:max-w-none">
									{s.description}
								</p>
							) : null}
						</div>
					</div>
				);
			},
			size: 480,
		},
		{
			id: "source",
			accessorFn: (s) => s.source_repo ?? s.source,
			enableSorting: false,
			header: "Source",
			cell: ({ row }) => {
				const s = row.original;
				return (
					<span
						className="truncate text-xs text-muted-foreground"
						title={s.source_repo ? `${s.source} · ${s.source_repo}` : s.source}
					>
						{s.source_repo ?? s.source}
					</span>
				);
			},
			size: 220,
		},
		{
			id: "updated_at",
			accessorKey: "updated_at",
			header: "Updated",
			cell: ({ row }) =>
				row.original.updated_at ? (
					<span className="whitespace-nowrap text-xs text-muted-foreground">
						{relativeTime(row.original.updated_at)}
					</span>
				) : null,
			size: 100,
		},
		{
			id: "actions",
			enableSorting: false,
			header: () => <span className="sr-only">Actions</span>,
			cell: ({ row }) => {
				const s = row.original;
				const projectId = s.project_id;
				const access = resolveSkillProjectAccess(s, options);
				// Shared-project skills are read-only here — the user is a
				// viewer, not the owner. Hide uninstall entirely; owner-side
				// management still happens in the source project.
				if (access !== "writable") return null;
				return (
					<ConfirmAction
						title={`Remove ${s.name} from Project?`}
						description={<p>Your other agents keep their copies.</p>}
						confirmLabel="Remove from Project"
						destructive
						onConfirm={() => {
							if (projectId) onUninstall(s.skill_key, projectId);
						}}
					>
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={uninstallPending || !projectId}
							onClick={(e) => e.stopPropagation()}
							className="text-muted-foreground opacity-100 transition-opacity duration-150 hover:text-destructive sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
							aria-label={`Remove ${s.name} from Project`}
						>
							<Trash2 className="size-3.5" />
						</Button>
					</ConfirmAction>
				);
			},
			size: 48,
		},
	];
}
