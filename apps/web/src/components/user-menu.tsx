"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Shared dropdown body for the signed-in user menu: identity header +
 * theme submenu + sign-out. Rendered identically inside the dashboard
 * sidebar's bottom user button and the public share page's top-right
 * avatar, so the menu reads the same wherever the user lands.
 *
 * The wrapping `<DropdownMenu>` + trigger + `<DropdownMenuContent>` are
 * the caller's responsibility — placement (side / align) differs
 * between the sidebar (right-aligned next to the rail) and the share
 * header (below the avatar in the top-right corner).
 */
export function UserMenuItems() {
	const { signOut } = useClerk();
	const { user } = useUser();
	const { theme, setTheme } = useTheme();

	return (
		<>
			<DropdownMenuLabel className="p-0 font-normal">
				<div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
					<Avatar className="h-8 w-8 rounded-lg">
						{user?.imageUrl ? <AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} /> : null}
						<AvatarFallback className="rounded-lg">{user?.fullName?.[0] ?? "U"}</AvatarFallback>
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
		</>
	);
}
