import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { isEmailAllowed } from "@/lib/email-allowlist";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
	// Private-beta gate. Only runs when ALLOWED_EMAIL_DOMAINS is set; otherwise
	// isEmailAllowed returns true for everyone. See lib/email-allowlist.ts.
	const user = await currentUser();
	const primaryEmail = user?.emailAddresses.find(
		(e) => e.id === user.primaryEmailAddressId,
	)?.emailAddress;
	if (!isEmailAllowed(primaryEmail)) {
		redirect("/access-denied");
	}

	return (
		<SidebarProvider
			style={
				{
					"--sidebar-width": "calc(var(--spacing) * 72)",
					"--header-height": "calc(var(--spacing) * 12)",
				} as React.CSSProperties
			}
		>
			<AppSidebar />
			{/* 1rem = SidebarInset's md:m-2 top+bottom. */}
			<SidebarInset className="md:h-[calc(100svh-1rem)] md:overflow-y-auto">
				<header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
					<div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
						<SidebarTrigger className="-ml-1" />
						<Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
						<AppBreadcrumb />
					</div>
				</header>
				<div className="flex flex-1 flex-col">
					<div className="@container/main flex flex-1 flex-col gap-2">
						<div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">{children}</div>
					</div>
				</div>
			</SidebarInset>
			<Toaster />
		</SidebarProvider>
	);
}
