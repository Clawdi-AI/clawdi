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
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
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
	const { state } = useSidebar();
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
			<Sidebar collapsible="icon">
				<SidebarHeader>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton size="lg" asChild>
								<Link href="/">
									<div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
										<Image src="/clawdi.svg" alt="" width={20} height={20} />
									</div>
									<div className="grid flex-1 text-left text-sm leading-tight">
										<span className="truncate font-semibold">Clawdi Cloud</span>
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
					<SidebarMenu>
						{navItems.map((item) => {
							const active =
								pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
							return (
								<SidebarMenuItem key={item.href}>
									<SidebarMenuButton asChild isActive={active} tooltip={item.label}>
										<Link href={item.href}>
											<item.icon className="size-4" />
											<span>{item.label}</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>
							);
						})}
					</SidebarMenu>
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
											<AvatarFallback className="rounded-lg bg-primary text-primary-foreground">
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
									side={state === "collapsed" ? "right" : "top"}
									align="end"
									sideOffset={4}
								>
									<DropdownMenuLabel className="p-0 font-normal">
										<div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
											<Avatar className="h-8 w-8 rounded-lg">
												{user?.imageUrl ? (
													<AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} />
												) : null}
												<AvatarFallback className="rounded-lg bg-primary text-primary-foreground">
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
										<Settings className="size-4" />
										Settings
									</DropdownMenuItem>
									<DropdownMenuItem onClick={() => openSettings("profile")}>
										<User className="size-4" />
										Profile
									</DropdownMenuItem>
									<DropdownMenuItem onClick={() => openSettings("api-keys")}>
										<Key className="size-4" />
										API Keys
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem onClick={() => signOut({ redirectUrl: "/sign-in" })}>
										<LogOut className="size-4" />
										Sign out
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarFooter>
			</Sidebar>

			<SettingsDialog
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				initialSection={settingsSection}
			/>
		</>
	);
}
