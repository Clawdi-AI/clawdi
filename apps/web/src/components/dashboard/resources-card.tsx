"use client";

import type { LucideIcon } from "lucide-react";
import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { PROJECT_RESOURCE_ICONS } from "@/components/project-resource-icons";
import { ProjectResourcePath } from "@/components/project-resource-path";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DashboardStats } from "@/lib/api-schemas";
import {
	getProjectResourceDefinition,
	PROJECT_CANONICAL_DEFINITION,
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
	count: number;
};

export type ProjectTypeCounts = {
	custom: number;
	global: number;
	agent: number;
};

const FIRST_PATH_STEPS = ["Create Project", "Add Skills or Vaults"];

function formatProjectTypeCounts(counts: ProjectTypeCounts) {
	return `${formatNumber(counts.custom)} Custom · ${formatNumber(counts.global)} Global · ${formatNumber(counts.agent)} Agent`;
}

function buildResources(stats: DashboardStats, projectCount: number): Resource[] {
	return PROJECT_RESOURCE_NAV_IDS.map((id) => {
		const definition = getProjectResourceDefinition(id);
		return {
			icon: PROJECT_RESOURCE_ICONS[id],
			definition,
			count: projectResourceCount(definition, stats, projectCount),
		};
	});
}

export function ResourcesCard({
	stats,
	projectCount,
	projectTypeCounts,
	projectCountLoading = false,
	hasConnectedAgent,
}: {
	stats: DashboardStats | undefined;
	projectCount: number | undefined;
	projectTypeCounts?: ProjectTypeCounts;
	projectCountLoading?: boolean;
	hasConnectedAgent?: boolean;
}) {
	const ready = stats && (!projectCountLoading || projectCount !== undefined);
	const waitingForAgent = hasConnectedAgent === false;
	const finalStep = waitingForAgent ? "Ready to Add to agent" : "Add to agent";
	// The "First path" walkthrough is onboarding — once the user has
	// created a custom Project they've walked the path, and the banner
	// is just permanent noise above their real counts. Hide it then.
	const established = (projectTypeCounts?.custom ?? 0) > 0;
	return (
		<Card className="gap-0 pb-0">
			<CardHeader className="border-b">
				<CardTitle>Resources</CardTitle>
				<CardDescription>
					{PROJECT_CANONICAL_DEFINITION} Agents run on your machines. Account resources (Sessions,
					Memories, Connectors) apply across all Projects.
				</CardDescription>
			</CardHeader>
			<CardContent className="p-0">
				{established ? null : (
					<div className="grid gap-3 border-b bg-muted/15 px-6 py-4 text-xs">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-medium text-foreground">
								{waitingForAgent ? "After connecting an agent" : "First path"}
							</span>
							{[...FIRST_PATH_STEPS, finalStep].map((step, index) => (
								<span
									key={step}
									className={cn(
										"inline-flex items-center gap-1 rounded-sm border bg-background px-2 py-1 text-muted-foreground",
										waitingForAgent && index === 2 && "border-dashed opacity-60",
									)}
								>
									<span className="font-medium tabular-nums text-foreground">{index + 1}.</span>
									{step}
								</span>
							))}
						</div>
						<p className="text-muted-foreground">
							Create Projects to share with teammates. Use the Global Project for defaults. Agent
							Projects stay private to one agent. Skills and Vaults live in Projects; Sessions,
							Memories, and Connectors apply account-wide.
						</p>
					</div>
				)}
				<div className="divide-y">
					{ready ? (
						<ProjectResourceGroups
							resources={buildResources(stats, projectCount ?? 0)}
							projectTypeCounts={projectTypeCounts}
						/>
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

function ProjectResourceGroups({
	resources,
	projectTypeCounts,
}: {
	resources: Resource[];
	projectTypeCounts?: ProjectTypeCounts;
}) {
	const byId = new Map(resources.map((resource) => [resource.definition.id, resource]));
	return (
		<>
			{PROJECT_RESOURCE_GROUPS.map((group) => (
				<div key={group.id}>
					<ResourceGroupLabel label={group.label} />
					{projectResourceDefinitionsForGroup(group.id).map((definition) => {
						const resource = byId.get(definition.id);
						return resource ? (
							<ResourceRow
								key={definition.id}
								resource={resource}
								projectTypeCounts={projectTypeCounts}
							/>
						) : null;
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

function ResourceRow({
	resource,
	projectTypeCounts,
}: {
	resource: Resource;
	projectTypeCounts?: ProjectTypeCounts;
}) {
	const empty = resource.count === 0;
	const Icon = resource.icon;
	const { definition } = resource;
	const scopeLabel =
		definition.id === "projects" && projectTypeCounts
			? formatProjectTypeCounts(projectTypeCounts)
			: projectResourceScopeLabel(definition.projectScope);
	const isProjectRow = definition.id === "projects";
	const count = (
		<span
			className={cn("text-sm tabular-nums", empty ? "text-muted-foreground" : "font-semibold")}
			title={scopeLabel}
		>
			{formatNumber(resource.count)}
		</span>
	);
	const countCluster =
		isProjectRow && empty ? (
			<span className="flex shrink-0 items-center gap-2" title={scopeLabel}>
				{count}
				<span className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground">
					1. Create Project
				</span>
			</span>
		) : (
			count
		);
	return (
		<Link
			href={definition.href}
			className="group flex items-center gap-3 px-6 py-3 transition-colors hover:bg-accent/40"
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
				<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
					<ProjectResourcePath resource={definition} />
					{isProjectRow && projectTypeCounts ? (
						<ProjectTypeBreakdown counts={projectTypeCounts} />
					) : null}
					{empty ? (
						<span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
							{isProjectRow ? "Start here" : `Start: ${definition.emptyCta}`}
						</span>
					) : (
						<span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
							<CheckCircle2 className="size-3" />
							Active
						</span>
					)}
				</div>
			</div>
			{isProjectRow && projectTypeCounts ? (
				<Tooltip>
					<TooltipTrigger asChild>{countCluster}</TooltipTrigger>
					<TooltipContent side="left">{scopeLabel}</TooltipContent>
				</Tooltip>
			) : (
				countCluster
			)}
		</Link>
	);
}

function ProjectTypeBreakdown({ counts }: { counts: ProjectTypeCounts }) {
	const items = [
		{ label: "Custom", count: counts.custom },
		{ label: "Global", count: counts.global },
		{ label: "Agent", count: counts.agent },
	];
	return (
		<span
			className="inline-flex min-w-0 flex-wrap items-center gap-1"
			title={`Project types: ${formatProjectTypeCounts(counts)}`}
		>
			{items.map((item) => (
				<span
					key={item.label}
					className="rounded-sm border bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
				>
					<span className="tabular-nums">{formatNumber(item.count)}</span> {item.label}
				</span>
			))}
		</span>
	);
}
