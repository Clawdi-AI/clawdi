import { ClerkOnly } from "../src/auth/clerk-only";
import { MfaScreen } from "../src/features/mfa";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<MfaScreen />
		</ClerkOnly>
	);
}
