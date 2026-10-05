import { ClerkOnly } from "../src/auth/clerk-only";
import { ProfileScreen } from "../src/features/profile";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<ProfileScreen />
		</ClerkOnly>
	);
}
