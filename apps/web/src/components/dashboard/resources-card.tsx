"use client";

import type { LucideIcon } from "lucide-react";
import {
	Brain,
	ChevronRight,
	FolderKanban,
	Key,
	MessageSquare,
	Plug,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardStats } from "@/lib/api-schemas";
import {
	getProjectResourceDefinition,
	type ProjectResourceDefinition,
	projectResourceCount,
	projectResourceScopeLabel,
} from "@/lib/project-resource-model";
import { cn, formatNumber } from "@/lib/utils";

type Resource = {
	icon: LucideIcon;
	definition: ProjectResourceDefinition;
	count: number;
};

const DASHBOARD_RESOURCE_IDS = [
	"projects",
	"skills",
	"vaults",
	"sessions",
	"memories",
	"connectors",
] as const;

const RESOURCE_ICONS = {
	projects: FolderKanban,
	skills: Sparkles,
	vaults: Key,
	sessions: MessageSquare,
	memories: Brain,
	connectors: Plug,
} satisfies Record<(typeof DASHBOARD_RESOURCE_IDS)[number], LucideIcon>;

function buildResources(stats: DashboardStats, projectCount: number): Resource[] {
	return DASHBOARD_RESOURCE_IDS.map((id) => {
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
					Projects organize reusable resources; global resources stay explicit.
				</CardDescription>
			</CardHeader>
			<CardContent className="p-0">
				<div className="divide-y">
					{ready
						? buildResources(stats, projectCount ?? 0).map((r) => (
								<ResourceRow key={r.definition.href} resource={r} />
							))
						: Array.from({ length: DASHBOARD_RESOURCE_IDS.length }).map((_, i) => (
								<ResourceRowSkeleton key={i} />
							))}
				</div>
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
				<div className="text-xs text-muted-foreground">
					{empty ? definition.emptyCta : projectResourceScopeLabel(definition.projectScope)}
				</div>
			</div>
			<span
				className={cn("text-sm tabular-nums", empty ? "text-muted-foreground" : "font-semibold")}
			>
				{formatNumber(resource.count)}
			</span>
			<ChevronRight className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
		</Link>
	);
}
