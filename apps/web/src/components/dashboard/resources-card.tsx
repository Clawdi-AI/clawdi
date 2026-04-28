"use client";

import type { LucideIcon } from "lucide-react";
import { Brain, ChevronRight, Key, Plug, Sparkles } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardStats } from "@/lib/api-schemas";
import { cn, formatNumber } from "@/lib/utils";

type Resource = {
	icon: LucideIcon;
	label: string;
	count: number;
	href: string;
	/** Copy shown inline with the count when count === 0 — calls the user to act. */
	emptyCta: string;
};

function buildResources(stats: DashboardStats): Resource[] {
	return [
		{
			icon: Brain,
			label: "Memories",
			count: stats.memories_count ?? 0,
			href: "/memories",
			emptyCta: "Add your first",
		},
		{
			icon: Sparkles,
			label: "Skills",
			count: stats.skills_count ?? 0,
			href: "/skills",
			emptyCta: "Browse marketplace",
		},
		{
			icon: Key,
			label: "Vault keys",
			count: stats.vault_keys_count ?? 0,
			href: "/vault",
			emptyCta: "Create your first",
		},
		{
			icon: Plug,
			label: "Connectors",
			count: stats.connectors_count ?? 0,
			href: "/connectors",
			emptyCta: "Connect an app",
		},
	];
}

export function ResourcesCard({ stats }: { stats: DashboardStats | undefined }) {
	return (
		<Card className="gap-0 pb-0">
			<CardHeader className="border-b">
				<CardTitle>Resources</CardTitle>
				<CardDescription>Shared across every connected agent.</CardDescription>
			</CardHeader>
			<CardContent className="p-0">
				<div className="divide-y">
					{stats
						? buildResources(stats).map((r) => <ResourceRow key={r.href} resource={r} />)
						: Array.from({ length: 4 }).map((_, i) => <ResourceRowSkeleton key={i} />)}
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
	return (
		<Link
			href={resource.href}
			className="group flex items-center gap-3 px-6 py-3 transition-colors hover:bg-accent/40"
		>
			<Icon className="size-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium">{resource.label}</div>
				{empty ? <div className="text-xs text-muted-foreground">{resource.emptyCta}</div> : null}
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
