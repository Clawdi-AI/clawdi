import { ClerkOnly } from "../src/auth/clerk-only";
import { EmailAddressesScreen } from "../src/features/account-contacts";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<EmailAddressesScreen />
		</ClerkOnly>
	);
}
