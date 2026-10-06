import { PhoneNumbersScreen } from "@/platform/account/account-contacts";
import { ClerkOnly } from "@/platform/auth/clerk-only";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<PhoneNumbersScreen />
		</ClerkOnly>
	);
}
