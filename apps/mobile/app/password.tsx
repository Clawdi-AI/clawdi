import { PasswordScreen } from "@/platform/account/password";
import { ClerkOnly } from "@/platform/auth/clerk-only";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<PasswordScreen />
		</ClerkOnly>
	);
}
