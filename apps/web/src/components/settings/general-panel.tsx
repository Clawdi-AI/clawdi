"use client";

import { isAppearanceMode } from "@clawdi/shared/consts";
import { generalPanelClasses } from "@clawdi/shared/ui";
import { settingsCopy, shouldShowAccountDeletionPage } from "@clawdi/shared/view";
import { UserCog } from "lucide-react";
import { lazy, Suspense, useState } from "react";
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

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

// Replaces Clerk's built-in delete only after self-deletion is disabled in Clerk.
const AccountProfileDialog = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/account/account-profile-dialog").then((m) => ({
				default: m.AccountProfileDialog,
			})),
		)
	: null;

const THEME_ITEMS = [
	{ label: "Light", value: "light" },
	{ label: "Dark", value: "dark" },
	{ label: "System", value: "system" },
] as const;

/** General settings — account identity and app-wide preferences. */
export function GeneralPanel() {
	const { theme, setTheme } = useTheme();
	const { user } = useCurrentUser();
	const actions = useAuthActions();
	const openProfile = "openUserProfile" in actions ? actions.openUserProfile : undefined;
	const [profileOpen, setProfileOpen] = useState(false);
	const DeletionProfileDialog =
		openProfile && shouldShowAccountDeletionPage(user) ? AccountProfileDialog : null;
	const initial = user?.fullName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "U";

	return (
		<div className={generalPanelClasses.panel}>
			<SettingsPanelHeader
				title={settingsCopy.general}
				description={settingsCopy.generalDescription}
			/>

			<SettingsSection
				headingLevel={3}
				title={settingsCopy.account}
				description={settingsCopy.accountDescription}
			>
				<div className={generalPanelClasses.accountRow}>
					<div className={generalPanelClasses.identity}>
						<Avatar className={generalPanelClasses.avatar}>
							{user?.imageUrl ? (
								<AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} />
							) : null}
							<AvatarFallback>{initial}</AvatarFallback>
						</Avatar>
						<div className={generalPanelClasses.identityText}>
							<div className={generalPanelClasses.name}>{user?.fullName ?? "Anonymous"}</div>
							<div className={generalPanelClasses.email}>
								{user?.primaryEmailAddress?.emailAddress}
							</div>
						</div>
					</div>
					{openProfile ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => (DeletionProfileDialog ? setProfileOpen(true) : openProfile())}
						>
							<UserCog className={generalPanelClasses.manageIcon} /> {settingsCopy.manageAccount}
						</Button>
					) : null}
					{DeletionProfileDialog ? (
						<Suspense fallback={null}>
							<DeletionProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
						</Suspense>
					) : null}
				</div>
			</SettingsSection>

			<SettingsSection headingLevel={3} title={settingsCopy.appearance}>
				<div className={generalPanelClasses.appearanceRow}>
					<div className={generalPanelClasses.appearanceLabel}>
						<Label htmlFor="settings-theme">{settingsCopy.theme}</Label>
						<p className={generalPanelClasses.description}>{settingsCopy.themeDescription}</p>
					</div>
					<Select
						items={THEME_ITEMS}
						value={theme ?? "system"}
						onValueChange={(value) => {
							if (isAppearanceMode(value)) setTheme(value);
						}}
					>
						<SelectTrigger
							id="settings-theme"
							data-testid="settings-theme-select"
							className={generalPanelClasses.themeTrigger}
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
