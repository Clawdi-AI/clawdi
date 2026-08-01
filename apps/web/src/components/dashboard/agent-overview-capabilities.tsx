import { Link } from "@tanstack/react-router";
import { ArrowRight, Cloud, Laptop } from "lucide-react";
import { DetailPanel } from "@/components/detail/layout";
import { agentCapabilities } from "@/lib/agent-capabilities";
import { type AgentRouteSearch, agentSectionLink } from "@/lib/agent-routes";
import type { AgentNavigationVariant } from "@/lib/navigation-model";

export function AgentOverviewCapabilities({
	agentId,
	variant,
	routeSearch,
}: {
	agentId: string;
	variant: AgentNavigationVariant;
	routeSearch: AgentRouteSearch;
}) {
	const capabilities = agentCapabilities(variant);
	const SourceIcon = variant === "hosted" ? Cloud : Laptop;
	return (
		<DetailPanel className="overflow-hidden p-0">
			<div className="flex flex-col gap-3 border-b bg-muted/20 p-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex min-w-0 gap-3">
					<div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
						<SourceIcon className="size-4 text-muted-foreground" />
					</div>
					<div className="min-w-0">
						<h2 className="text-sm font-semibold">{capabilities.label}</h2>
						<p className="mt-0.5 text-sm text-muted-foreground">{capabilities.description}</p>
					</div>
				</div>
				<p className="max-w-sm text-xs text-muted-foreground sm:text-right">
					{capabilities.management}
				</p>
			</div>
			<div className="grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
				{capabilities.overviewCapabilities.map((capability) => (
					<Link
						key={capability.section}
						{...agentSectionLink(agentId, capability.section, routeSearch)}
						className="group flex min-w-0 items-start justify-between gap-3 p-4 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					>
						<div className="min-w-0">
							<div className="text-sm font-medium">{capability.label}</div>
							<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
								{capability.description}
							</p>
						</div>
						<ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
					</Link>
				))}
			</div>
		</DetailPanel>
	);
}
