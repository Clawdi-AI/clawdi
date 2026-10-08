"use client";

import { siteHeaderClasses } from "@clawdi/shared/ui";

import { lazy, type ReactNode, Suspense } from "react";
import { useAccountDataIdentity } from "@/components/account-suspension-boundary";
import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { NotificationCenter } from "@/components/notification-center";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const HostedNotificationCenter = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/notification-center").then((module) => ({
				default: module.HostedNotificationCenter,
			})),
		)
	: null;

/**
 * Dashboard chrome — the header bar above SidebarInset content.
 * Keeps shadcn dashboard-01's trigger/separator/content/action shape,
 * with Clawdi-specific breadcrumbs and notifications.
 */
export function SiteHeader({ actions }: { actions?: ReactNode }) {
	const ready = Boolean(useAccountDataIdentity());
	return (
		<header className={`${siteHeaderClasses.root} ${siteHeaderClasses.pageSurface}`}>
			<div className={siteHeaderClasses.content}>
				<SidebarTrigger className={siteHeaderClasses.sidebarTrigger} />
				<Separator orientation="vertical" className={siteHeaderClasses.sidebarSeparator} />
				<div className={siteHeaderClasses.breadcrumbs}>
					<AppBreadcrumb />
				</div>
				{actions}
				{!ready ? (
					<Skeleton className={siteHeaderClasses.notificationSkeleton} />
				) : HostedNotificationCenter ? (
					<Suspense fallback={<NotificationCenter />}>
						<HostedNotificationCenter />
					</Suspense>
				) : (
					<NotificationCenter />
				)}
			</div>
		</header>
	);
}
