import { ClerkOnly } from "../src/auth/clerk-only";
import { PhoneNumbersScreen } from "../src/features/account-contacts";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<PhoneNumbersScreen />
		</ClerkOnly>
	);
}
