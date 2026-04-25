"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
	BarChart3,
	Brain,
	ChevronsUpDown,
	CircleHelp,
	CirclePlus,
	ExternalLink,
	Key,
	LayoutDashboard,
	LogOut,
	Mail,
	MessageCircle,
	Monitor,
	Moon,
	Plug,
	Rocket,
	Search,
	Settings,
	Sparkles,
	Sun,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useState } from "react";
import { useCommandPalette } from "@/components/command-palette";
import { AddAgentDialog } from "@/components/dashboard/add-agent-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
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
	const { isMobile } = useSidebar();
	const { theme, setTheme } = useTheme();
	const { setOpen: setPaletteOpen } = useCommandPalette();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [addAgentOpen, setAddAgentOpen] = useState(false);

	return (
		<>
			<Sidebar collapsible="icon" variant="inset">
				<SidebarHeader>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton size="lg" asChild>
								<Link href="/">
									<Image
										src="/clawdi-logo-transparent.png"
										alt=""
										width={32}
										height={32}
										className="size-8 shrink-0"
									/>
									<span className="truncate text-base font-semibold">Clawdi Cloud</span>
								</Link>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarHeader>

				<SidebarContent>
					{/* Primary nav — mirrors dashboard-01's NavMain: a Quick Create
					    button up top, main nav items below. */}
					<SidebarGroup>
						<SidebarGroupContent className="flex flex-col gap-2">
							<SidebarMenu>
								<SidebarMenuItem>
									<SidebarMenuButton
										tooltip="Add an agent"
										onClick={() => setAddAgentOpen(true)}
										className="bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
									>
										<CirclePlus />
										<span>Add an agent</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
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
						</SidebarGroupContent>
					</SidebarGroup>

					{/* Secondary nav pinned to the bottom of SidebarContent — matches
					    dashboard-01's NavSecondary pattern. */}
					<SidebarGroup className="mt-auto">
						<SidebarGroupContent>
							<SidebarMenu>
								<SidebarMenuItem>
									<SidebarMenuButton tooltip="Search (⌘K)" onClick={() => setPaletteOpen(true)}>
										<Search />
										<span>Search</span>
										<KbdGroup className="ml-auto">
											<Kbd>⌘</Kbd>
											<Kbd>K</Kbd>
										</KbdGroup>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									{/* Cross-product link: this app manages already-deployed
									    agents; clawdi.ai's dashboard is where users spin up
									    a brand-new one. External link, new tab, with the
									    arrow icon so the destination isn't a surprise. */}
									<SidebarMenuButton asChild tooltip="Deploy a new agent">
										<a
											href="https://www.clawdi.ai/dashboard"
											target="_blank"
											rel="noopener noreferrer"
										>
											<Rocket />
											<span>Deploy a new agent</span>
											<ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
										</a>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton tooltip="Settings" onClick={() => setSettingsOpen(true)}>
										<Settings />
										<span>Settings</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									{/* Help → support email + Telegram. Mirrors the navbar
									    pattern from the public clawdi repo so users hit the
									    same channels everywhere. */}
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<SidebarMenuButton tooltip="Help">
												<CircleHelp />
												<span>Help</span>
											</SidebarMenuButton>
										</DropdownMenuTrigger>
										<DropdownMenuContent
											side={isMobile ? "bottom" : "right"}
											align="end"
											className="min-w-56"
										>
											<DropdownMenuItem asChild>
												<a href="mailto:support@clawdi.ai">
													<Mail />
													support@clawdi.ai
												</a>
											</DropdownMenuItem>
											<DropdownMenuItem asChild>
												<a
													href="https://t.me/clawdiofficial"
													target="_blank"
													rel="noopener noreferrer"
												>
													<MessageCircle />
													Telegram @clawdiofficial
												</a>
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarGroupContent>
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
									<DropdownMenuSub>
										<DropdownMenuSubTrigger>
											{theme === "dark" ? <Moon /> : theme === "light" ? <Sun /> : <Monitor />}
											Theme
										</DropdownMenuSubTrigger>
										<DropdownMenuSubContent>
											<DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
												<DropdownMenuRadioItem value="light">
													<Sun />
													Light
												</DropdownMenuRadioItem>
												<DropdownMenuRadioItem value="dark">
													<Moon />
													Dark
												</DropdownMenuRadioItem>
												<DropdownMenuRadioItem value="system">
													<Monitor />
													System
												</DropdownMenuRadioItem>
											</DropdownMenuRadioGroup>
										</DropdownMenuSubContent>
									</DropdownMenuSub>
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
			</Sidebar>

			<SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
			<AddAgentDialog open={addAgentOpen} onClose={() => setAddAgentOpen(false)} />
		</>
	);
}
