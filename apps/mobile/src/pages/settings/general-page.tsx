import { GeneralPanel } from "@/components/settings/general-panel";
import { SettingsShell } from "@/components/settings/shell";

export default function AccountRoute() {
	return (
		<SettingsShell>
			<GeneralPanel />
		</SettingsShell>
	);
}
