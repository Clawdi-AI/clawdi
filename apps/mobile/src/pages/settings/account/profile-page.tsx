import { ProfileScreen } from "@/platform/account/profile";
import { ClerkOnly } from "@/platform/auth/clerk-only";
export default function AccountPage() {
	return (
		<ClerkOnly>
			<ProfileScreen />
		</ClerkOnly>
	);
}
