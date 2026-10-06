import { PasswordScreen } from "@/platform/account/password";
import { ClerkOnly } from "@/platform/auth/clerk-only";
export default function AccountPage() {
	return (
		<ClerkOnly>
			<PasswordScreen />
		</ClerkOnly>
	);
}
