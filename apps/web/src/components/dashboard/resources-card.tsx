"use client";

import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { PROJECT_RESOURCE_ICONS } from "@/components/project-resource-icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardStats } from "@/lib/api-schemas";
import {
	getProjectResourceDefinition,
	PROJECT_RESOURCE_GROUPS,
	PROJECT_RESOURCE_NAV_IDS,
	type ProjectResourceDefinition,
	projectResourceCount,
	projectResourceDefinitionsForGroup,
	projectResourceScopeLabel,
} from "@/lib/project-resource-model";
import { RESOURCE_TINT_CLASSES } from "@/lib/resource-identity";
import { cn, formatNumber } from "@/lib/utils";

type Resource = {
	icon: LucideIcon;
	definition: ProjectResourceDefinition;
	count: number | null;
};

function buildResources(stats: DashboardStats): Resource[] {
	return PROJECT_RESOURCE_NAV_IDS.map((id) => {
		const definition = getProjectResourceDefinition(id);
		return {
			icon: PROJECT_RESOURCE_ICONS[id],
			definition,
			count: projectResourceCount(definition, stats, stats.projects_count),
		};
	});
}

export function ResourcesCard({
	stats,
	statsError,
	onRetryStats,
}: {
	stats: DashboardStats | undefined;
	statsError?: unknown;
	onRetryStats?: () => void;
}) {
	const ready = stats && !statsError;
	return (
		<Card className="gap-0 pb-0">
			<CardHeader className="border-b">
				<CardTitle>Library</CardTitle>
			</CardHeader>
			<CardContent className="p-0">
				{statsError ? (
					<div className="p-6">
						<ApiErrorPanel
							error={statsError}
							onRetry={onRetryStats}
							title="Couldn't load resources"
						/>
					</div>
				) : (
					<div className="divide-y">
						{ready ? (
							<ProjectResourceGroups resources={buildResources(stats)} />
						) : (
							PROJECT_RESOURCE_GROUPS.map((group) => (
								<div key={group.id}>
									{group.resourceIds.length > 1 ? <ResourceGroupLabel label={group.label} /> : null}
									{group.resourceIds.map((id) => (
										<ResourceRowSkeleton key={id} />
									))}
								</div>
							))
						)}
					</div>
				)}
				{ready && stats.projects_count === 0 ? (
					<div className="border-t px-6 py-3 text-xs text-muted-foreground">
						Next:{" "}
						<Link
							to="/projects"
							className="font-medium text-foreground underline-offset-4 hover:underline"
						>
							create your first Project
						</Link>{" "}
						to organize reusable skills and credentials for your agents.
					</div>
				) : null}
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
					{group.resourceIds.length > 1 ? <ResourceGroupLabel label={group.label} /> : null}
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
	const countUnavailable = resource.count === null;
	const empty = resource.count === 0;
	const Icon = resource.icon;
	const { definition } = resource;
	const scopeLabel = projectResourceScopeLabel(definition.projectScope);
	const isProjectRow = definition.id === "projects";
	const count = (
		<span
			className={cn(
				"text-sm tabular-nums",
				empty || countUnavailable ? "text-muted-foreground" : "font-semibold",
			)}
			title={scopeLabel}
		>
			{countUnavailable ? "—" : formatNumber(resource.count ?? 0)}
		</span>
	);
	const countCluster =
		isProjectRow && empty ? (
			<span className="flex shrink-0 items-center gap-2" title={scopeLabel}>
				{count}
				<span className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground">
					1. Create project
				</span>
			</span>
		) : (
			count
		);
	return (
		<Link
			to={definition.href}
			className="group flex items-center gap-3 px-6 py-3 transition-colors hover:bg-muted/50"
		>
			{/* Same identity hue as this resource's sidebar chip — the rail
			    and the nav read as one system. */}
			<span
				className={cn(
					"flex size-7 shrink-0 items-center justify-center rounded-lg",
					RESOURCE_TINT_CLASSES[definition.id],
				)}
			>
				<Icon className="size-3.5" />
			</span>
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium">{definition.label}</div>
			</div>
			{countCluster}
		</Link>
	);
}
