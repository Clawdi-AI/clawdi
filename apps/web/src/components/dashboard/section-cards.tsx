"use client";

import { Brain, Key, Plug, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardAction,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardStats } from "@/lib/api-schemas";
import { formatNumber } from "@/lib/utils";

/**
 * Headline stat cards at the top of the dashboard. Matches the shadcn
 * `dashboard-01` SectionCards pattern (each card is a `@container/card`
 * so the big number scales with its own width).
 *
 * Product framing: these show the four manageable resources — Memories,
 * Skills, Vault Keys, Connectors — not usage metrics. That keeps the
 * page informative even for accounts that haven't synced sessions yet.
 */
export function SectionCards({ stats }: { stats: DashboardStats | undefined }) {
	if (!stats) {
		return <SectionCardsSkeleton />;
	}

	return (
		<div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
			<StatCard
				description="Memories"
				value={formatNumber(stats.memories_count ?? 0)}
				badge={
					<Badge variant="outline">
						<Brain />
						Knowledge
					</Badge>
				}
				footerTitle="Shared across every agent"
				footerDescription="Recallable via MCP on any connected machine"
			/>
			<StatCard
				description="Skills"
				value={formatNumber(stats.skills_count ?? 0)}
				badge={
					<Badge variant="outline">
						<Sparkles />
						Installed
					</Badge>
				}
				footerTitle="Portable agent instructions"
				footerDescription="One definition, every agent gets it"
			/>
			<StatCard
				description="Vault keys"
				value={formatNumber(stats.vault_keys_count ?? 0)}
				badge={
					<Badge variant="outline">
						<Key />
						Encrypted
					</Badge>
				}
				footerTitle="AES-256-GCM at rest"
				footerDescription="Injected into agent runtime via clawdi run"
			/>
			<StatCard
				description="Connectors"
				value={formatNumber(stats.connectors_count ?? 0)}
				badge={
					<Badge variant="outline">
						<Plug />
						Apps
					</Badge>
				}
				footerTitle="External tools your agents can call"
				footerDescription="OAuth handled, MCP ready"
			/>
		</div>
	);
}

function StatCard({
	description,
	value,
	badge,
	footerTitle,
	footerDescription,
}: {
	description: string;
	value: string;
	badge: ReactNode;
	footerTitle: ReactNode;
	footerDescription: ReactNode;
}) {
	return (
		<Card className="@container/card">
			<CardHeader>
				<CardDescription>{description}</CardDescription>
				<CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
					{value}
				</CardTitle>
				<CardAction>{badge}</CardAction>
			</CardHeader>
			<CardFooter className="flex-col items-start gap-1.5 text-sm">
				<div className="line-clamp-1 font-medium">{footerTitle}</div>
				<div className="text-muted-foreground">{footerDescription}</div>
			</CardFooter>
		</Card>
	);
}

function SectionCardsSkeleton() {
	return (
		<div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
			{Array.from({ length: 4 }).map((_, i) => (
				<Card key={i} className="@container/card">
					<CardHeader>
						<Skeleton className="h-4 w-20" />
						<Skeleton className="h-8 w-28" />
					</CardHeader>
					<CardFooter className="flex-col items-start gap-1.5">
						<Skeleton className="h-4 w-40" />
						<Skeleton className="h-3 w-32" />
					</CardFooter>
				</Card>
			))}
		</div>
	);
}
