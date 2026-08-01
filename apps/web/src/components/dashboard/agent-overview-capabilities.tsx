import { Link } from "@tanstack/react-router";
import { ArrowRight, Cloud, Laptop, type LucideIcon, Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { IconChip } from "@/components/icon-chip";
import { type AgentOverviewModuleId, agentOverviewGroups } from "@/lib/agent-capabilities";
import { type AgentRouteSearch, agentSectionLink } from "@/lib/agent-routes";
import {
	AGENT_SECTION_NAVIGATION_ITEMS,
	type AgentNavigationVariant,
} from "@/lib/navigation-model";
import { cn } from "@/lib/utils";

export type AgentOverviewModuleContent = {
	value: ReactNode;
	detail: ReactNode;
	content?: ReactNode;
	items?: readonly string[];
};

const MODULE_PRESENTATION: Record<
	AgentOverviewModuleId,
	{
		label?: string;
		icon?: LucideIcon;
		tint?: string;
		accent: string;
		emphasis?: string;
		header?: string;
	}
> = {
	sessions: { accent: "border-t-identity-3-fg/45" },
	"live-sync": {
		label: "Live Sync",
		icon: Laptop,
		tint: "bg-identity-7-bg text-identity-7-fg",
		accent: "border-t-identity-7-fg/60",
		emphasis: "border-identity-7-fg/25 bg-identity-7-bg/20",
		header: "bg-identity-7-bg/30",
	},
	"agent-interface": {
		label: "Agent Interface",
		icon: Cloud,
		tint: "bg-identity-6-bg text-identity-6-fg",
		accent: "border-t-identity-6-fg/60",
		emphasis: "border-identity-6-fg/25 bg-identity-6-bg/20",
		header: "bg-identity-6-bg/30",
	},
	projects: { accent: "border-t-identity-1-fg/45" },
	skills: { accent: "border-t-identity-2-fg/45" },
	memories: { accent: "border-t-identity-6-fg/45" },
	vaults: { accent: "border-t-identity-4-fg/45" },
	connectors: { accent: "border-t-identity-7-fg/45" },
	"model-provider": { label: "Model & Provider", accent: "border-t-identity-2-fg/45" },
	channels: { accent: "border-t-identity-5-fg/45" },
	compute: {
		label: "Compute",
		icon: Settings2,
		tint: "bg-identity-4-bg text-identity-4-fg",
		accent: "border-t-identity-4-fg/45",
	},
};

export function AgentOverviewCapabilities({
	agentId,
	variant,
	routeSearch,
	content,
}: {
	agentId: string;
	variant: AgentNavigationVariant;
	routeSearch: AgentRouteSearch;
	content: Partial<Record<AgentOverviewModuleId, AgentOverviewModuleContent>>;
}) {
	return (
		<div className="flex flex-col gap-8" data-agent-overview={variant}>
			{agentOverviewGroups(variant).map((group) => (
				<section key={group.id} aria-labelledby={`agent-overview-${group.id}`}>
					<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
						<h2 id={`agent-overview-${group.id}`} className="text-sm font-semibold">
							{group.label}
						</h2>
						<p className="text-xs text-muted-foreground">{group.description}</p>
					</div>
					<div className="grid gap-3 md:grid-cols-3">
						{group.modules.map((module) => {
							const item = AGENT_SECTION_NAVIGATION_ITEMS[module.section];
							const presentation = MODULE_PRESENTATION[module.id];
							const moduleContent = content[module.id];
							const Icon = presentation.icon ?? item.icon;
							const title = presentation.label ?? item.label;
							return (
								<article
									key={module.id}
									data-overview-module={module.id}
									className={cn(
										"min-w-0 overflow-hidden rounded-xl border border-t-2 bg-card shadow-xs",
										presentation.accent,
										presentation.emphasis,
										module.size === "wide" && "md:col-span-2",
									)}
								>
									<Link
										{...agentSectionLink(agentId, module.section, routeSearch)}
										className={cn(
											"group flex items-center gap-3 p-4 pb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
											presentation.header,
										)}
									>
										<IconChip size="sm" tint={presentation.tint ?? item.tint}>
											<Icon />
										</IconChip>
										<h3 className="min-w-0 flex-1 text-sm font-semibold">{title}</h3>
										<ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
									</Link>
									<div className="px-4 pb-4">
										<div className="text-lg font-semibold tracking-tight">
											{moduleContent?.value ?? "Available"}
										</div>
										<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
											{moduleContent?.detail ?? item.description}
										</p>
										{moduleContent?.items?.length ? (
											<ul className="mt-4 flex flex-wrap gap-1.5" aria-label={`${title} summary`}>
												{moduleContent.items.slice(0, 3).map((summaryItem) => (
													<li
														key={summaryItem}
														className="max-w-full truncate rounded-full bg-identity-1-bg/60 px-2.5 py-1 text-xs font-medium text-identity-1-fg"
													>
														{summaryItem}
													</li>
												))}
											</ul>
										) : null}
										{moduleContent?.content ? (
											<div className="mt-4 border-t pt-3">{moduleContent.content}</div>
										) : null}
									</div>
								</article>
							);
						})}
					</div>
				</section>
			))}
		</div>
	);
}
