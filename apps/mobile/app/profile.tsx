import { ProfileScreen } from "@/platform/account/profile";
import { ClerkOnly } from "@/platform/auth/clerk-only";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<ProfileScreen />
		</ClerkOnly>
	);
}
