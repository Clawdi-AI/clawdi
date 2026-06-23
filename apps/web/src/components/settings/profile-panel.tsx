"use client";

import { UserCog } from "lucide-react";
import { SettingsPanelHeader } from "@/components/settings/settings-shell";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthActions, useCurrentUser } from "@/lib/auth-client";

/** Profile settings — read-only identity. Clerk owns account editing, so we
 * hand off to its hosted profile modal rather than a dead-end read-only view. */
export function ProfilePanel() {
	const { user } = useCurrentUser();
	const actions = useAuthActions();
	// Only real Clerk exposes openUserProfile (dev-bypass returns just signOut).
	const openProfile = "openUserProfile" in actions ? actions.openUserProfile : undefined;
	const initial = user?.fullName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "U";

	return (
		<div className="space-y-6 px-4 lg:px-6">
			<SettingsPanelHeader title="Profile" description="Your account identity." />
			<div className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex items-center gap-4">
					<Avatar className="size-14">
						{user?.imageUrl ? <AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} /> : null}
						<AvatarFallback>{initial}</AvatarFallback>
					</Avatar>
					<div className="space-y-0.5">
						<div className="text-sm font-medium">{user?.fullName ?? "Anonymous"}</div>
						<div className="text-sm text-muted-foreground">
							{user?.primaryEmailAddress?.emailAddress}
						</div>
					</div>
				</div>
				{openProfile ? (
					<Button variant="outline" size="sm" onClick={() => openProfile()}>
						<UserCog className="size-3.5" />
						Manage account
					</Button>
				) : null}
			</div>
		</div>
	);
}
