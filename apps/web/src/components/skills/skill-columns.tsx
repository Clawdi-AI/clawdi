"use client";

import type { components } from "@clawdi/shared/api";
import type { ColumnDef } from "@tanstack/react-table";
import { Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { skillDetailHref } from "@/lib/project-resource-model";
import { relativeTime } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

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
// `writableProjectIds` is the ownership boundary. A skill can live
// outside the currently selected agent project and still be writable
// when it belongs to the user (for example, preserved skills from a
// disconnected agent). Viewer memberships render read-only.
export type SkillProjectAccess = "writable" | "read-only" | "unknown";

export interface SkillColumnOptions {
	currentProjectId?: string | null;
	writableProjectIds?: ReadonlySet<string> | null;
}

export function resolveSkillProjectAccess(
	skill: Pick<SkillSummary, "project_id">,
	options: SkillColumnOptions = {},
): SkillProjectAccess {
	if (!skill.project_id) return "unknown";
	if (options.writableProjectIds) {
		return options.writableProjectIds.has(skill.project_id) ? "writable" : "read-only";
	}
	if (options.currentProjectId && skill.project_id === options.currentProjectId) return "writable";
	return "unknown";
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
				const href = skillDetailHref(s.skill_key, s.project_id);
				const access = resolveSkillProjectAccess(s, options);
				return (
					<div className="flex items-start gap-2">
						<Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
						<div className="min-w-0 flex-1 space-y-0.5">
							<div className="flex items-center gap-2">
								<Link
									href={href}
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
												? `Shared from "${sourceProjectName}" — read-only`
												: "Shared from another project — read-only"
										}
									>
										shared
									</Badge>
								) : null}
							</div>
							{s.description ? (
								<p className="line-clamp-1 text-xs text-muted-foreground">{s.description}</p>
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
					<Button
						variant="ghost"
						size="icon-sm"
						disabled={uninstallPending || !projectId}
						onClick={(e) => {
							e.stopPropagation();
							if (!projectId) return;
							const ok = window.confirm(
								`Uninstall "${s.name}" from this agent?\n\n` +
									"Your other agents keep their copies.",
							);
							if (ok) onUninstall(s.skill_key, projectId);
						}}
						className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
						aria-label={`Uninstall ${s.name}`}
					>
						<Trash2 className="size-3.5" />
					</Button>
				);
			},
			size: 48,
		},
	];
}
