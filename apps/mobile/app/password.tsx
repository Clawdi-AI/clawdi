import { ClerkOnly } from "../src/auth/clerk-only";
import { PasswordScreen } from "../src/features/password";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<PasswordScreen />
		</ClerkOnly>
	);
}
