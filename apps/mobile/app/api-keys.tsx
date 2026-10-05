import { ApiKeysPanel } from "../src/ui/settings/api-keys-panel";
import { SettingsShell } from "../src/ui/settings/shell";
export default function ApiKeysRoute() {
	return (
		<SettingsShell active="api-keys" back>
			<ApiKeysPanel />
		</SettingsShell>
	);
}
