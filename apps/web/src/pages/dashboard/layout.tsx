"use client";

import { lazy, type ReactNode, Suspense, useCallback, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { BreadcrumbTitleProvider } from "@/components/breadcrumb-title";
import { CommandPaletteProvider } from "@/components/command-palette";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import {
	type AgentOwnership,
	AgentOwnershipProvider,
	EMPTY_AGENT_OWNERSHIP,
} from "@/lib/agent-ownership";
import {
	LOADING_PRODUCT_ACCESS,
	type ProductAccess,
	ProductAccessProvider,
	UNAVAILABLE_PRODUCT_ACCESS,
} from "@/lib/product-access";
import { useHydrated } from "@/lib/use-hydrated";

// Cap dashboard content at 1536px (= Tailwind's 2xl screen) and center it in
// SidebarInset. Below that width the constraint is inert; above it (27"/4K
// external monitors) the main pane stops stretching into unreadable row
// widths and overly-thin grids. shadcn's dashboard-01 reference omits this
// cap because its demo environment is a standard viewport — productionising
// it means adding one.
const CONTENT_MAX_WIDTH = "max-w-[96rem]";
const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const HostedProductAccessSensor = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/access/product-access-sensor").then((m) => ({
				default: m.HostedProductAccessSensor,
			})),
		)
	: null;

const HostedAgentOwnershipSensor = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/agents/ownership-sensor").then((m) => ({
				default: m.HostedAgentOwnershipSensor,
			})),
		)
	: null;

const GlobalWalletBalance = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/global-wallet-balance").then((m) => ({
				default: m.GlobalWalletBalance,
			})),
		)
	: null;

export default function DashboardLayout({ children }: { children: ReactNode }) {
	const hydrated = useHydrated();
	const [ownership, setOwnership] = useState<AgentOwnership | null>(null);
	const [existingCloudDeploymentCount, setExistingCloudDeploymentCount] = useState<number | null>(
		null,
	);
	const [productAccess, setProductAccess] = useState<ProductAccess>(() =>
		IS_HOSTED_BUILD ? LOADING_PRODUCT_ACCESS : UNAVAILABLE_PRODUCT_ACCESS,
	);
	const showOwnershipSensor = hydrated && Boolean(HostedAgentOwnershipSensor);
	const updateHostedOwnership = useCallback(
		(nextOwnership: AgentOwnership | null, nextExistingCloudDeploymentCount: number | null) => {
			setOwnership(nextOwnership);
			setExistingCloudDeploymentCount(nextExistingCloudDeploymentCount);
		},
		[],
	);
	// `null` strictly means "resolving" (destructive actions wait on it), so
	// the shell decides when there is no external control plane: OSS builds.
	// The hosted sensor reports resolved-empty ownership when its Deploy API is
	// unavailable. Hosted builds with a configured Deploy API keep resolving
	// deployment ownership even when new v2 deploys are disabled, because
	// existing Cloud deployments remain manageable under rollback.
	const noExternalControlPlane = !IS_HOSTED_BUILD;
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
			<ProductAccessProvider value={productAccess}>
				{HostedProductAccessSensor ? (
					<Suspense fallback={null}>
						<HostedProductAccessSensor onChange={setProductAccess} />
					</Suspense>
				) : null}
				<AgentOwnershipProvider value={providedOwnership}>
					{HostedAgentOwnershipSensor && showOwnershipSensor ? (
						<Suspense fallback={null}>
							<HostedAgentOwnershipSensor onChange={updateHostedOwnership} />
						</Suspense>
					) : null}
					<CommandPaletteProvider>
						<BreadcrumbTitleProvider>
							<AppSidebar variant="inset" />
							{/* 1rem = SidebarInset's md:m-2 top+bottom when the sidebar uses
							    dashboard-01's inset variant. Keep the scroll container inside
							    the inset so the sticky SiteHeader pins correctly. */}
							<SidebarInset
								id="dashboard-scroll-container"
								data-scroll-restoration-id="dashboard-scroll-container"
								className="md:h-[calc(100svh-1rem)] md:overflow-y-auto"
							>
								<SiteHeader
									actions={
										IS_HOSTED_BUILD ? (
											<DashboardHeaderActionSlot>
												{GlobalWalletBalance ? (
													<Suspense fallback={<Skeleton className="h-8 w-full" />}>
														<GlobalWalletBalance
															existingCloudDeploymentCount={existingCloudDeploymentCount}
														/>
													</Suspense>
												) : null}
											</DashboardHeaderActionSlot>
										) : null
									}
								/>
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
			</ProductAccessProvider>
		</SidebarProvider>
	);
}

function DashboardHeaderActionSlot({ children }: { children?: ReactNode }) {
	return (
		<div
			data-testid="global-wallet-balance-slot"
			className="flex h-8 w-fit min-w-20 shrink items-stretch"
		>
			{children}
		</div>
	);
}
