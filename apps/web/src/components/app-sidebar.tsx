"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
	BarChart3,
	Brain,
	ChevronsUpDown,
	Key,
	LayoutDashboard,
	LogOut,
	Plug,
	Settings,
	Sparkles,
	User,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { SettingsDialog } from "@/components/settings-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	useSidebar,
} from "@/components/ui/sidebar";

const navItems = [
	{ href: "/", label: "Overview", icon: LayoutDashboard },
	{ href: "/sessions", label: "Sessions", icon: BarChart3 },
	{ href: "/memories", label: "Memories", icon: Brain },
	{ href: "/skills", label: "Skills", icon: Sparkles },
	{ href: "/vault", label: "Vault", icon: Key },
	{ href: "/connectors", label: "Connectors", icon: Plug },
];

export function AppSidebar() {
	const pathname = usePathname();
	const { signOut } = useClerk();
	const { user } = useUser();
	const { isMobile } = useSidebar();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsSection, setSettingsSection] = useState<"general" | "profile" | "api-keys">(
		"general",
	);

	const openSettings = (section: "general" | "profile" | "api-keys") => {
		setSettingsSection(section);
		setSettingsOpen(true);
	};

	return (
		<>
			<Sidebar collapsible="icon" variant="inset">
				{/* Brand — logo already has its own colors, no filled background */}
				<SidebarHeader>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton size="lg" asChild>
								<Link href="/">
									<Image
										src="/clawdi.svg"
										alt=""
										width={32}
										height={32}
										className="size-8 shrink-0"
									/>
									<div className="grid flex-1 text-left leading-tight">
										<span className="truncate text-sm font-semibold">Clawdi Cloud</span>
										<span className="truncate text-xs text-muted-foreground">
											iCloud for AI Agents
										</span>
									</div>
								</Link>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarHeader>

				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupLabel>Workspace</SidebarGroupLabel>
						<SidebarMenu>
							{navItems.map((item) => {
								const active =
									pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
								return (
									<SidebarMenuItem key={item.href}>
										<SidebarMenuButton asChild isActive={active} tooltip={item.label}>
											<Link href={item.href}>
												<item.icon />
												<span>{item.label}</span>
											</Link>
										</SidebarMenuButton>
									</SidebarMenuItem>
								);
							})}
						</SidebarMenu>
					</SidebarGroup>
				</SidebarContent>

				<SidebarFooter>
					<SidebarMenu>
						<SidebarMenuItem>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<SidebarMenuButton
										size="lg"
										className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
									>
										<Avatar className="h-8 w-8 rounded-lg">
											{user?.imageUrl ? (
												<AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} />
											) : null}
											<AvatarFallback className="rounded-lg">
												{user?.fullName?.[0] ?? "U"}
											</AvatarFallback>
										</Avatar>
										<div className="grid flex-1 text-left text-sm leading-tight">
											<span className="truncate font-medium">{user?.fullName}</span>
											<span className="truncate text-xs text-muted-foreground">
												{user?.primaryEmailAddress?.emailAddress}
											</span>
										</div>
										<ChevronsUpDown className="ml-auto size-4" />
									</SidebarMenuButton>
								</DropdownMenuTrigger>
								<DropdownMenuContent
									className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
									side={isMobile ? "bottom" : "right"}
									align="end"
									sideOffset={4}
								>
									<DropdownMenuLabel className="p-0 font-normal">
										<div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
											<Avatar className="h-8 w-8 rounded-lg">
												{user?.imageUrl ? (
													<AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} />
												) : null}
												<AvatarFallback className="rounded-lg">
													{user?.fullName?.[0] ?? "U"}
												</AvatarFallback>
											</Avatar>
											<div className="grid flex-1 text-left text-sm leading-tight">
												<span className="truncate font-medium">{user?.fullName}</span>
												<span className="truncate text-xs text-muted-foreground">
													{user?.primaryEmailAddress?.emailAddress}
												</span>
											</div>
										</div>
									</DropdownMenuLabel>
									<DropdownMenuSeparator />
									<DropdownMenuItem onClick={() => openSettings("general")}>
										<Settings />
										Settings
									</DropdownMenuItem>
									<DropdownMenuItem onClick={() => openSettings("profile")}>
										<User />
										Profile
									</DropdownMenuItem>
									<DropdownMenuItem onClick={() => openSettings("api-keys")}>
										<Key />
										API Keys
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem onClick={() => signOut({ redirectUrl: "/sign-in" })}>
										<LogOut />
										Sign out
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarFooter>

				<SidebarRail />
			</Sidebar>

			<SettingsDialog
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				initialSection={settingsSection}
			/>
		</>
	);
}
