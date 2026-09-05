"use client";

import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { toast } from "sonner";
import { useTheme } from "@/components/theme-provider";
import { TruncatedText } from "@/components/truncated-text";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthActions, useCurrentUser } from "@/lib/auth-client";

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
	const { signOut } = useAuthActions();
	const { user } = useCurrentUser();
	const { theme, setTheme } = useTheme();
	const setThemeFromMenu = (value: string) => {
		if (value === "light" || value === "dark" || value === "system") {
			setTheme(value);
		}
	};

	return (
		<>
			<DropdownMenuGroup>
				<DropdownMenuLabel className="p-0 font-normal">
					<div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
						<Avatar className="h-8 w-8 rounded-lg">
							{user?.imageUrl ? (
								<AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} />
							) : null}
							<AvatarFallback className="rounded-lg">{user?.fullName?.[0] ?? "U"}</AvatarFallback>
						</Avatar>
						<div className="grid flex-1 text-left text-sm leading-tight">
							<TruncatedText className="font-medium">{user?.fullName}</TruncatedText>
							<TruncatedText className="text-xs text-muted-foreground">
								{user?.primaryEmailAddress?.emailAddress}
							</TruncatedText>
						</div>
					</div>
				</DropdownMenuLabel>
			</DropdownMenuGroup>
			<DropdownMenuSeparator />
			<DropdownMenuGroup>
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						{theme === "dark" ? <Moon /> : theme === "light" ? <Sun /> : <Monitor />}
						Theme
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setThemeFromMenu}>
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
			</DropdownMenuGroup>
			<DropdownMenuSeparator />
			<DropdownMenuGroup>
				<DropdownMenuItem
					onClick={() =>
						void signOut({ redirectUrl: "/sign-in" }).catch(() =>
							toast.error("Couldn't sign out", {
								description: "Clawdi could not finish signing out safely. Try again.",
							}),
						)
					}
				>
					<LogOut />
					Sign out
				</DropdownMenuItem>
			</DropdownMenuGroup>
		</>
	);
}
