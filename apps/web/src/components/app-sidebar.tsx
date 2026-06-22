"use client";

import {
	BookOpen,
	Brain,
	ChevronsUpDown,
	CircleHelp,
	CirclePlus,
	ExternalLink,
	FolderKanban,
	Key,
	LayoutDashboard,
	type LucideIcon,
	Mail,
	MessageCircle,
	MessageSquare,
	Plug,
	Search,
	Settings,
	Sparkles,
} from "lucide-react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useCommandPalette } from "@/components/command-palette";
import { AddAgentDialog } from "@/components/dashboard/add-agent-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar";
import { UserMenuItems } from "@/components/user-menu";
import { useCurrentUser } from "@/lib/auth-client";
import { IS_HOSTED } from "@/lib/hosted";
import { useHostedV2Access } from "@/lib/hosted-v2-access";
import {
	PROJECT_RESOURCE_GROUPS,
	type ProjectResourceId,
	projectResourceDefinitionsForGroup,
	projectResourceScopeLabel,
} from "@/lib/project-resource-model";
import { RESOURCE_TINT_CLASSES } from "@/lib/resource-identity";
import { cn } from "@/lib/utils";

// Dynamic import gated on the build-time `IS_HOSTED` constant. OSS
// builds collapse the conditional, the bundler eliminates the
// import() site, and the hosted DeployTrigger chunk (which carries
// the `https://www.clawdi.ai/dashboard` URL constant) never ships.
const DeployTrigger = IS_HOSTED
	? dynamic(() => import("@/hosted/deploy-trigger").then((m) => ({ default: m.DeployTrigger })))
	: null;

const RESOURCE_ICONS = {
	projects: FolderKanban,
	skills: Sparkles,
	vaults: Key,
	sessions: MessageSquare,
	memories: Brain,
	connectors: Plug,
} satisfies Record<ProjectResourceId, LucideIcon>;

/** Tinted chip around a nav icon — the identity-palette hue carries the
 * "vivid, colourful" art direction into the app chrome itself, and each
 * resource keeps the same hue here, in the overview Resources rail, and
 * on its own pages. The chip (not the glyph) is colored so icons stay
 * one visual weight. */
function NavIconChip({ tint, children }: { tint: string; children: React.ReactNode }) {
	return (
		<span
			className={cn(
				"flex size-5 shrink-0 items-center justify-center rounded-md [&>svg]:size-3.5",
				tint,
			)}
		>
			{children}
		</span>
	);
}

function GitHubIcon({ className, ...props }: React.ComponentProps<"svg">) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
			className={className}
			{...props}
		>
			<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.757-1.333-1.757-1.09-.745.083-.729.083-.729 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.997.108-.775.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.468-2.382 1.235-3.222-.123-.303-.535-1.523.118-3.176 0 0 1.008-.322 3.3 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.29-1.552 3.296-1.23 3.296-1.23.655 1.653.243 2.873.12 3.176.77.84 1.233 1.912 1.233 3.222 0 4.61-2.805 5.625-5.475 5.922.43.372.823 1.103.823 2.222 0 1.605-.015 2.898-.015 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
		</svg>
	);
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
	const pathname = usePathname();
	const { user } = useCurrentUser();
	const { isMobile } = useSidebar();
	const { setOpen: setPaletteOpen } = useCommandPalette();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [addAgentOpen, setAddAgentOpen] = useState(false);
	const hostedV2 = useHostedV2Access();

	return (
		<>
			<Sidebar collapsible="icon" {...props}>
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
										tooltip="Add agent"
										onClick={() => setAddAgentOpen(true)}
										className="bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
									>
										<CirclePlus />
										<span>Add agent</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
							<SidebarMenu>
								<SidebarMenuItem>
									<SidebarMenuButton asChild isActive={pathname === "/"} tooltip="Overview">
										<Link href="/">
											<NavIconChip tint={RESOURCE_TINT_CLASSES.overview}>
												<LayoutDashboard />
											</NavIconChip>
											<span>Overview</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>

					{PROJECT_RESOURCE_GROUPS.map((group) => (
						<SidebarGroup key={group.id} className="pt-0">
							<SidebarGroupLabel>{group.label}</SidebarGroupLabel>
							<SidebarGroupContent>
								<SidebarMenu>
									{projectResourceDefinitionsForGroup(group.id).map((definition) => {
										const Icon = RESOURCE_ICONS[definition.id];
										const active =
											pathname === definition.href || pathname.startsWith(`${definition.href}/`);
										return (
											<SidebarMenuItem key={definition.id}>
												<SidebarMenuButton
													asChild
													isActive={active}
													tooltip={`${definition.navLabel} - ${projectResourceScopeLabel(
														definition.projectScope,
													)}`}
												>
													<Link href={definition.href}>
														<NavIconChip tint={RESOURCE_TINT_CLASSES[definition.id]}>
															<Icon />
														</NavIconChip>
														<span>{definition.navLabel}</span>
													</Link>
												</SidebarMenuButton>
											</SidebarMenuItem>
										);
									})}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					))}

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
								{/* `DeployTrigger` is `null` in OSS builds and additionally hidden
								    until the hosted backend allows this user to use v2. */}
								{DeployTrigger && hostedV2.canUseV2 ? <DeployTrigger /> : null}
								<SidebarMenuItem>
									<SidebarMenuButton asChild tooltip="Docs">
										<a
											href="https://deepwiki.com/Clawdi-AI/clawdi"
											target="_blank"
											rel="noopener noreferrer"
										>
											<BookOpen />
											<span>Docs</span>
											<ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
										</a>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton asChild tooltip="GitHub">
										<a
											href="https://github.com/Clawdi-AI/clawdi"
											target="_blank"
											rel="noopener noreferrer"
										>
											<GitHubIcon />
											<span>GitHub</span>
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
									<UserMenuItems />
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
