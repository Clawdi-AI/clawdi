"use client";

import { Search } from "lucide-react";
import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { useCommandPalette } from "@/components/command-palette";
import { NotificationCenter } from "@/components/notification-center";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

/**
 * Dashboard chrome — the header bar above SidebarInset content.
 * Mirrors shadcn's dashboard-01 site-header block so the layout stays
 * aligned with the upstream reference.
 */
export function SiteHeader() {
	const { setOpen: setPaletteOpen } = useCommandPalette();

	return (
		<header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
			<div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
				<SidebarTrigger className="-ml-1" />
				<Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
				<div className="min-w-0 flex-1">
					<AppBreadcrumb />
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-9 min-w-9 gap-2 px-2 md:px-3"
					aria-label="Search, Command K or Control K"
					onClick={() => setPaletteOpen(true)}
				>
					<Search className="size-4" aria-hidden="true" />
					<span className="hidden md:inline">Search</span>
					<KbdGroup className="hidden md:inline-flex">
						<Kbd>⌘</Kbd>
						<Kbd>K</Kbd>
					</KbdGroup>
				</Button>
				<NotificationCenter />
			</div>
		</header>
	);
}
