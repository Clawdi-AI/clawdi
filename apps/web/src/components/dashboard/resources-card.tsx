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
	type ProjectResourceDefinition,
	projectResourceCount,
	projectResourceScopeLabel,
} from "@/lib/project-resource-model";
import { RESOURCE_TINT_CLASSES } from "@/lib/resource-identity";
import { cn, formatNumber } from "@/lib/utils";

type Resource = {
	icon: LucideIcon;
	definition: ProjectResourceDefinition;
	count: number | null;
};

const LIBRARY_ROW_IDS = ["projects", "skills", "vaults", "connectors"] as const;

function buildResources(stats: DashboardStats): Resource[] {
	return LIBRARY_ROW_IDS.map((id) => {
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
						{ready
							? buildResources(stats).map((resource) => (
									<ResourceRow key={resource.definition.id} resource={resource} />
								))
							: LIBRARY_ROW_IDS.map((id) => <ResourceRowSkeleton key={id} />)}
					</div>
				)}
			</CardContent>
		</Card>
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
			{count}
		</Link>
	);
}
