import { MfaScreen } from "@/platform/account/mfa";
import { ClerkOnly } from "@/platform/auth/clerk-only";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<MfaScreen />
		</ClerkOnly>
	);
}
