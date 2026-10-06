import { DeviceSessionsScreen } from "@/platform/account/device-sessions";
import { ClerkOnly } from "@/platform/auth/clerk-only";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<DeviceSessionsScreen />
		</ClerkOnly>
	);
}
