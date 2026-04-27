"use client";

import { ExternalLink, Rocket } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

/**
 * Sidebar entry for hosted users.
 *
 * Cross-product link: clawdi-cloud (this app) is the agent
 * management home; clawdi.ai/dashboard owns the actual deploy
 * flow (plan selection, Stripe checkout, runtime configuration).
 * The two stay separate because mirroring the deploy form here
 * would mean maintaining two copies of plan/billing/Stripe
 * integration — a real maintenance tax with marginal UX benefit
 * for users who'd see the same form behind a different URL.
 *
 * After deploy, the new agent shows up in cloud's unified
 * Agents grid via the cross-origin listing, with a "Manage ↗"
 * link back into clawdi.ai/dashboard for chat/files/lifecycle.
 */
export function DeployTrigger() {
	return (
		<SidebarMenuItem data-hosted="true">
			<SidebarMenuButton asChild tooltip="Deploy a new agent">
				<a href="https://www.clawdi.ai/dashboard" target="_blank" rel="noopener noreferrer">
					<Rocket />
					<span>Deploy a new agent</span>
					<ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
				</a>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}
