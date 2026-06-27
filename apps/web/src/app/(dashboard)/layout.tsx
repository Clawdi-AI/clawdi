import { Suspense } from "react";
import { pageMetadata } from "@/app/page-metadata";
import { AppSidebar } from "@/components/app-sidebar";
import { BreadcrumbTitleProvider } from "@/components/breadcrumb-title";
import { CommandPaletteProvider } from "@/components/command-palette";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";

export const metadata = pageMetadata(
	"Overview",
	"Monitor connected agents, recent activity, onboarding, and Clawdi resources.",
);

// Cap dashboard content at 1536px (= Tailwind's 2xl screen) and center it in
// SidebarInset. Below that width the constraint is inert; above it (27"/4K
// external monitors) the main pane stops stretching into unreadable row
// widths and overly-thin grids. shadcn's dashboard-01 reference omits this
// cap because its demo environment is a standard viewport — productionising
// it means adding one.
const CONTENT_MAX_WIDTH = "max-w-[96rem]";

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

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
	return (
		<SidebarProvider
			defaultOpen
			style={
				{
					"--sidebar-width": "calc(var(--spacing) * 64)",
					"--clawdi-rail-width": "calc(var(--spacing) * 16)",
					"--header-height": "calc(var(--spacing) * 12)",
				} as React.CSSProperties
			}
		>
			<CommandPaletteProvider>
				<BreadcrumbTitleProvider>
					<Suspense fallback={<AppSidebarFallback />}>
						<AppSidebar variant="inset" />
					</Suspense>
					{/* 1rem = SidebarInset's md:m-2 top+bottom when the sidebar uses
					    dashboard-01's inset variant. Keep the scroll container inside
					    the inset so the sticky SiteHeader pins correctly. */}
					<SidebarInset className="md:h-[calc(100svh-1rem)] md:overflow-y-auto">
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
		</SidebarProvider>
	);
}
