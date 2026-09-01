"use client";

import { lazy, type ReactNode, Suspense } from "react";
import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { NotificationCenter } from "@/components/notification-center";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const HostedCustomerIONotificationCenter = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/customerio-notification-center").then((module) => ({
				default: module.CustomerIONotificationCenter,
			})),
		)
	: null;

/**
 * Dashboard chrome — the header bar above SidebarInset content.
 * Keeps shadcn dashboard-01's trigger/separator/content/action shape,
 * with Clawdi-specific breadcrumbs and notifications.
 */
export function SiteHeader({ actions }: { actions?: ReactNode }) {
	return (
		<header
			data-clawdi-window-drag-region
			className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background"
		>
			<div className="flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
				<SidebarTrigger className="-ml-1 md:hidden" />
				<Separator
					orientation="vertical"
					className="mx-2 h-4 data-vertical:self-center md:hidden"
				/>
				<div className="min-w-8 flex-1 overflow-hidden">
					<AppBreadcrumb />
				</div>
				{actions}
				{HostedCustomerIONotificationCenter ? (
					<Suspense fallback={<NotificationCenter />}>
						<HostedCustomerIONotificationCenter />
					</Suspense>
				) : (
					<NotificationCenter />
				)}
			</div>
		</header>
	);
}
