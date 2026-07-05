"use client";

import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { BreadcrumbTitleProvider } from "@/components/breadcrumb-title";
import { CommandPaletteProvider } from "@/components/command-palette";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import {
	type AgentOwnership,
	AgentOwnershipProvider,
	EMPTY_AGENT_OWNERSHIP,
} from "@/lib/agent-ownership";
import { IS_HOSTED } from "@/lib/hosted";
import { isDeployApiConfigured } from "@/lib/hosted-api";
import { useHostedProductAccess } from "@/lib/hosted-product-access";

// Cap dashboard content at 1536px (= Tailwind's 2xl screen) and center it in
// SidebarInset. Below that width the constraint is inert; above it (27"/4K
// external monitors) the main pane stops stretching into unreadable row
// widths and overly-thin grids. shadcn's dashboard-01 reference omits this
// cap because its demo environment is a standard viewport — productionising
// it means adding one.
const CONTENT_MAX_WIDTH = "max-w-[96rem]";
const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const HostedAgentOwnershipSensor = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/agents/ownership-sensor").then((m) => ({
				default: m.HostedAgentOwnershipSensor,
			})),
		)
	: null;

function AppSidebarFallback() {
	return (
		<>
			<div
				aria-hidden
				className="sticky top-0 hidden h-svh w-(--clawdi-rail-width) shrink-0 border-r bg-sidebar/95 md:block"
			/>
			<div
				aria-hidden
				data-state="expanded"
				data-collapsible=""
				data-variant="inset"
				data-side="left"
				data-slot="sidebar"
				className="group peer hidden text-sidebar-foreground md:block"
			>
				<div data-slot="sidebar-gap" className="relative w-(--sidebar-width) bg-transparent" />
				<div
					data-slot="sidebar-container"
					className="fixed inset-y-0 left-[var(--clawdi-rail-width)] z-10 hidden h-svh w-(--sidebar-width) p-2 md:flex"
				>
					<div className="flex h-full w-full flex-col bg-sidebar" />
				</div>
			</div>
		</>
	);
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
	const hostedAccess = useHostedProductAccess();
	const [mounted, setMounted] = useState(false);
	const [ownership, setOwnership] = useState<AgentOwnership | null>(null);
	useEffect(() => {
		setMounted(true);
	}, []);
	const showOwnershipSensor =
		mounted &&
		IS_HOSTED &&
		(hostedAccess.canUseCloudAgents || hostedAccess.canUseLegacyHostedDashboard);
	// `null` strictly means "resolving" (destructive actions wait on it), so
	// the provider must decide when there is nothing to resolve: OSS builds,
	// hosted mirrors without a configured deploy API, and hosted users whose
	// access check SUCCEEDED with no hosted capabilities get the resolved
	// empty ownership immediately. Everything else — loading, or the access
	// check erroring — stays `null`: destructive actions fail closed, since a
	// failed /me cannot distinguish a capability-less user from a legacy user
	// whose live agents must not expose Disconnect.
	const noExternalControlPlane =
		!IS_HOSTED ||
		!isDeployApiConfigured() ||
		(mounted &&
			!hostedAccess.isLoading &&
			!hostedAccess.error &&
			!hostedAccess.canUseCloudAgents &&
			!hostedAccess.canUseLegacyHostedDashboard);
	const providedOwnership = noExternalControlPlane ? EMPTY_AGENT_OWNERSHIP : ownership;

	return (
		<SidebarProvider
			defaultOpen
			style={
				{
					"--sidebar-width": "calc(var(--spacing) * 64)",
					"--clawdi-rail-width": "calc(var(--spacing) * 20)",
					"--header-height": "calc(var(--spacing) * 12)",
				} as React.CSSProperties
			}
		>
			<AgentOwnershipProvider value={providedOwnership}>
				{HostedAgentOwnershipSensor && showOwnershipSensor ? (
					<Suspense fallback={null}>
						<HostedAgentOwnershipSensor onChange={setOwnership} />
					</Suspense>
				) : null}
				<CommandPaletteProvider>
					<BreadcrumbTitleProvider>
						<Suspense fallback={<AppSidebarFallback />}>
							<AppSidebar variant="inset" />
						</Suspense>
						{/* 1rem = SidebarInset's md:m-2 top+bottom when the sidebar uses
						    dashboard-01's inset variant. Keep the scroll container inside
						    the inset so the sticky SiteHeader pins correctly. */}
						<SidebarInset
							id="dashboard-scroll-container"
							data-scroll-restoration-id="dashboard-scroll-container"
							className="md:h-[calc(100svh-1rem)] md:overflow-y-auto"
						>
							<SiteHeader />
							<div className="flex flex-1 flex-col">
								<div className="@container/main flex flex-1 flex-col gap-2">
									<div
										className={`mx-auto flex w-full ${CONTENT_MAX_WIDTH} flex-col gap-4 py-4 md:gap-5 md:py-5`}
									>
										{children}
									</div>
								</div>
							</div>
						</SidebarInset>
						<Toaster />
					</BreadcrumbTitleProvider>
				</CommandPaletteProvider>
			</AgentOwnershipProvider>
		</SidebarProvider>
	);
}
