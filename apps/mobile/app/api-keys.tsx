import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { SettingsShell } from "@/components/settings/shell";
export default function ApiKeysRoute() {
	return (
		<SettingsShell active="api-keys" back>
			<ApiKeysPanel />
		</SettingsShell>
	);
}
