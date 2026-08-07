"use client";

import { UserCog } from "lucide-react";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { SettingsSection } from "@/components/settings-section";
import { useTheme } from "@/components/theme-provider";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useAuthActions, useCurrentUser } from "@/lib/auth-client";

const THEME_ITEMS = [
	{ label: "Light", value: "light" },
	{ label: "Dark", value: "dark" },
	{ label: "System", value: "system" },
] as const;

type ThemeItemValue = (typeof THEME_ITEMS)[number]["value"];

function isThemeItemValue(value: string | null): value is ThemeItemValue {
	return value === "light" || value === "dark" || value === "system";
}

/** General settings — account identity and app-wide preferences. */
export function GeneralPanel() {
	const { theme, setTheme } = useTheme();
	const { user } = useCurrentUser();
	const actions = useAuthActions();
	const openProfile = "openUserProfile" in actions ? actions.openUserProfile : undefined;
	const initial = user?.fullName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "U";

	return (
		<div className="flex flex-col gap-8 px-5 sm:px-6 lg:px-8">
			<SettingsPanelHeader title="General" description="Account and app preferences." />

			<SettingsSection headingLevel={3} title="Account" description="Your Clawdi identity.">
				<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex min-w-0 items-center gap-3">
						<Avatar className="size-11 shrink-0">
							{user?.imageUrl ? (
								<AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} />
							) : null}
							<AvatarFallback>{initial}</AvatarFallback>
						</Avatar>
						<div className="min-w-0">
							<div className="truncate text-sm font-medium">{user?.fullName ?? "Anonymous"}</div>
							<div className="truncate text-sm text-muted-foreground">
								{user?.primaryEmailAddress?.emailAddress}
							</div>
						</div>
					</div>
					{openProfile ? (
						<Button variant="outline" size="sm" onClick={() => openProfile()}>
							<UserCog className="size-3.5" /> Manage account
						</Button>
					) : null}
				</div>
			</SettingsSection>

			<SettingsSection headingLevel={3} title="Appearance">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-0.5">
						<Label htmlFor="settings-theme">Theme</Label>
						<p className="text-xs text-muted-foreground">Light, dark, or match your system.</p>
					</div>
					<Select
						items={THEME_ITEMS}
						value={theme ?? "system"}
						onValueChange={(value) => {
							if (isThemeItemValue(value)) setTheme(value);
						}}
					>
						<SelectTrigger
							id="settings-theme"
							data-testid="settings-theme-select"
							className="w-full sm:w-40"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{THEME_ITEMS.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</SettingsSection>
		</div>
	);
}
