import { ClerkOnly } from "../src/auth/clerk-only";
import { DeviceSessionsScreen } from "../src/features/device-sessions";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<DeviceSessionsScreen />
		</ClerkOnly>
	);
}
