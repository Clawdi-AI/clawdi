"use client";

import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { useTheme } from "@/components/theme-provider";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

/** General settings — appearance + app-wide preferences. */
export function GeneralPanel() {
	const { theme, setTheme } = useTheme();

	return (
		<div className="space-y-6 px-4 lg:px-6">
			<SettingsPanelHeader title="General" description="Appearance and app-wide preferences." />
			<div className="flex items-center justify-between gap-4 rounded-lg border p-4">
				<div className="space-y-0.5">
					<Label htmlFor="settings-theme">Theme</Label>
					<p className="text-xs text-muted-foreground">
						Light, dark, or follow the system preference.
					</p>
				</div>
				<Select
					value={theme ?? "system"}
					onValueChange={(value) => {
						if (value !== null) setTheme(value);
					}}
				>
					<SelectTrigger id="settings-theme" className="w-[160px]">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="light">Light</SelectItem>
						<SelectItem value="dark">Dark</SelectItem>
						<SelectItem value="system">System</SelectItem>
					</SelectContent>
				</Select>
			</div>
		</div>
	);
}
