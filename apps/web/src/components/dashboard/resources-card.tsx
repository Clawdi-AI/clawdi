"use client";

import type { LucideIcon } from "lucide-react";
import { Brain, FolderKanban, Key, MessageSquare, Plug, Sparkles } from "lucide-react";
import Link from "next/link";
import { ProjectResourcePath } from "@/components/project-resource-path";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardStats } from "@/lib/api-schemas";
import {
	getProjectResourceDefinition,
	PROJECT_RESOURCE_GROUPS,
	PROJECT_RESOURCE_NAV_IDS,
	type ProjectResourceDefinition,
	type ProjectResourceId,
	projectResourceCount,
	projectResourceDefinitionsForGroup,
	projectResourceScopeLabel,
} from "@/lib/project-resource-model";
import { cn, formatNumber } from "@/lib/utils";

type Resource = {
	icon: LucideIcon;
	definition: ProjectResourceDefinition;
	count: number;
};

const RESOURCE_ICONS = {
	projects: FolderKanban,
	skills: Sparkles,
	vaults: Key,
	sessions: MessageSquare,
	memories: Brain,
	connectors: Plug,
} satisfies Record<ProjectResourceId, LucideIcon>;

function buildResources(stats: DashboardStats, projectCount: number): Resource[] {
	return PROJECT_RESOURCE_NAV_IDS.map((id) => {
		const definition = getProjectResourceDefinition(id);
		return {
			icon: RESOURCE_ICONS[id],
			definition,
			count: projectResourceCount(definition, stats, projectCount),
		};
	});
}

export function ResourcesCard({
	stats,
	projectCount,
	projectCountLoading = false,
}: {
	stats: DashboardStats | undefined;
	projectCount: number | undefined;
	projectCountLoading?: boolean;
}) {
	const ready = stats && (!projectCountLoading || projectCount !== undefined);
	return (
		<Card className="gap-0 pb-0">
			<CardHeader className="border-b">
				<CardTitle>Resources</CardTitle>
				<CardDescription>
					Start at Projects for shareable work. Account resources live separately.
				</CardDescription>
			</CardHeader>
			<CardContent className="p-0">
				<div className="divide-y">
					{ready ? (
						<ProjectResourceGroups resources={buildResources(stats, projectCount ?? 0)} />
					) : (
						PROJECT_RESOURCE_GROUPS.map((group) => (
							<div key={group.id}>
								<ResourceGroupLabel label={group.label} />
								{group.resourceIds.map((id) => (
									<ResourceRowSkeleton key={id} />
								))}
							</div>
						))
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function ProjectResourceGroups({ resources }: { resources: Resource[] }) {
	const byId = new Map(resources.map((resource) => [resource.definition.id, resource]));
	return (
		<>
			{PROJECT_RESOURCE_GROUPS.map((group) => (
				<div key={group.id}>
					<ResourceGroupLabel label={group.label} />
					{projectResourceDefinitionsForGroup(group.id).map((definition) => {
						const resource = byId.get(definition.id);
						return resource ? <ResourceRow key={definition.id} resource={resource} /> : null;
					})}
				</div>
			))}
		</>
	);
}

function ResourceGroupLabel({ label }: { label: string }) {
	return (
		<div className="bg-muted/20 px-6 py-2 text-xs font-medium text-muted-foreground">{label}</div>
	);
}

function ResourceRowSkeleton() {
	return (
		<div className="flex items-center gap-3 px-6 py-3">
			<Skeleton className="size-4" />
			<Skeleton className="h-4 flex-1" />
			<Skeleton className="h-4 w-8" />
		</div>
	);
}

function ResourceRow({ resource }: { resource: Resource }) {
	const empty = resource.count === 0;
	const Icon = resource.icon;
	const { definition } = resource;
	return (
		<Link
			href={definition.href}
			className="group flex items-center gap-3 px-6 py-3 transition-colors hover:bg-accent/40"
		>
			<Icon className="size-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium">{definition.label}</div>
				<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
					<ProjectResourcePath resource={definition} />
					{empty ? (
						<span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
							{definition.emptyCta}
						</span>
					) : null}
				</div>
			</div>
			<span
				className={cn("text-sm tabular-nums", empty ? "text-muted-foreground" : "font-semibold")}
				title={projectResourceScopeLabel(definition.projectScope)}
			>
				{formatNumber(resource.count)}
			</span>
		</Link>
	);
}
