"use client";

import type { ReactNode } from "react";
import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { NotificationCenter } from "@/components/notification-center";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

/**
 * Dashboard chrome — the header bar above SidebarInset content.
 * Keeps shadcn dashboard-01's trigger/separator/content/action shape,
 * with Clawdi-specific breadcrumbs and notifications.
 */
export function SiteHeader({ actions }: { actions?: ReactNode }) {
	return (
		<header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background">
			<div className="flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
				<SidebarTrigger className="-ml-1" />
				<Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
				<div className="min-w-8 flex-1 overflow-hidden">
					<AppBreadcrumb />
				</div>
				{actions}
				<NotificationCenter />
			</div>
		</header>
	);
}
