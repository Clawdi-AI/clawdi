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

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
	return (
		<SidebarProvider
			style={
				{
					"--sidebar-width": "calc(var(--spacing) * 72)",
					"--header-height": "calc(var(--spacing) * 12)",
				} as React.CSSProperties
			}
		>
			<CommandPaletteProvider>
				<BreadcrumbTitleProvider>
					<AppSidebar />
					<SidebarInset className="md:h-svh md:overflow-y-auto">
						<SiteHeader />
						<div className="flex flex-1 flex-col">
							<div className="@container/main flex flex-1 flex-col gap-2">
								<div
									className={`mx-auto flex w-full ${CONTENT_MAX_WIDTH} flex-col gap-4 py-4 md:gap-6 md:py-6`}
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
