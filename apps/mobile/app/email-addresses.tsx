import { EmailAddressesScreen } from "@/platform/account/account-contacts";
import { ClerkOnly } from "@/platform/auth/clerk-only";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<EmailAddressesScreen />
		</ClerkOnly>
	);
}
