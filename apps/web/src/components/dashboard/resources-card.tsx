"use client";

import { resourcesCardClasses } from "@clawdi/shared/ui";

import {
	DASHBOARD_COPY,
	dashboardResources,
	formatNumber,
	LIBRARY_ROW_IDS,
	type ProjectResourceDefinition,
	projectResourceScopeLabel,
} from "@clawdi/shared/view";
import { Link } from "@tanstack/react-router";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { PROJECT_RESOURCE_ICONS } from "@/components/project-resource-icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardStats } from "@/lib/api-schemas";
import { RESOURCE_TINT_CLASSES } from "@/lib/resource-identity";
import { cn } from "@/lib/utils";

type Resource = {
	definition: ProjectResourceDefinition;
	count: number | null;
};

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
		<Card className={resourcesCardClasses.gap0Pb0}>
			<CardHeader className={resourcesCardClasses.borderB}>
				<CardTitle>{DASHBOARD_COPY.libraryTitle}</CardTitle>
			</CardHeader>
			<CardContent className={resourcesCardClasses.p0}>
				{statsError ? (
					<div className={resourcesCardClasses.p6}>
						<ApiErrorPanel
							error={statsError}
							onRetry={onRetryStats}
							title={DASHBOARD_COPY.libraryError}
						/>
					</div>
				) : (
					<div className="divide-y">
						{ready
							? dashboardResources(stats).map((resource) => (
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
		<div className={resourcesCardClasses.flexItemsCenterGap3}>
			<Skeleton className={resourcesCardClasses.size4} />
			<Skeleton className={resourcesCardClasses.h4Flex1} />
			<Skeleton className={resourcesCardClasses.h4W8} />
		</div>
	);
}

function ResourceRow({ resource }: { resource: Resource }) {
	const countUnavailable = resource.count === null;
	const empty = resource.count === 0;
	const Icon = PROJECT_RESOURCE_ICONS[resource.definition.id];
	const { definition } = resource;
	const scopeLabel = projectResourceScopeLabel(definition.projectScope);
	const count = (
		<span
			className={cn(
				resourcesCardClasses.textSmTabularNums,
				empty || countUnavailable
					? resourcesCardClasses.textMutedForeground
					: resourcesCardClasses.fontSemibold,
			)}
			title={scopeLabel}
		>
			{countUnavailable ? "—" : formatNumber(resource.count ?? 0)}
		</span>
	);
	return (
		<Link to={definition.href} className={resourcesCardClasses.groupFlexItemsCenterGap}>
			{/* Same identity hue as this resource's sidebar chip — the rail
			    and the nav read as one system. */}
			<span
				className={cn(resourcesCardClasses.flexSize7Shrink0, RESOURCE_TINT_CLASSES[definition.id])}
			>
				<Icon className={resourcesCardClasses.size35} />
			</span>
			<div className={resourcesCardClasses.minW0Flex1}>
				<div className={resourcesCardClasses.textSmFontMedium}>{definition.label}</div>
			</div>
			{count}
		</Link>
	);
}
