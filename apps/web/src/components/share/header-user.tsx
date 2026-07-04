"use client";

import { SignInButton } from "@clerk/tanstack-react-start";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserMenuItems } from "@/components/user-menu";
import { useCurrentUser } from "@/lib/auth-client";

/**
 * Top-right user affordance for the public share header.
 *
 * Signed-in visitor: avatar opens the same menu the dashboard sidebar
 * uses (theme + sign-out). Anonymous visitor: a plain Sign-in button —
 * the modal returns them to the same page.
 *
 * `useUser` is unresolved on the first paint (SSR), so the slot is
 * empty until Clerk hydrates. Acceptable layout shift for a corner
 * affordance; matches Clerk's own `<UserButton>` behavior.
 */
export function ShareHeaderUser() {
	const { isLoaded, isSignedIn, user } = useCurrentUser();
	if (!isLoaded) {
		return <div className="size-8" />;
	}
	if (!isSignedIn) {
		return (
			<SignInButton mode="modal">
				<Button variant="ghost" size="sm">
					Sign in
				</Button>
			</SignInButton>
		);
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button
						type="button"
						aria-label="Account menu"
						className="rounded-full ring-offset-background transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					/>
				}
			>
				<Avatar className="size-8">
					{user.imageUrl ? <AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} /> : null}
					<AvatarFallback>{user.fullName?.[0] ?? "U"}</AvatarFallback>
				</Avatar>
			</DropdownMenuTrigger>
			<DropdownMenuContent side="bottom" align="end" sideOffset={8} className="min-w-56">
				<UserMenuItems />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
