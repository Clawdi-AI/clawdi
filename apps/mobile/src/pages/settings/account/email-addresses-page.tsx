import { EmailAddressesScreen } from "@/platform/account/account-contacts";
import { ClerkOnly } from "@/platform/auth/clerk-only";
export default function AccountPage() {
	return (
		<ClerkOnly>
			<EmailAddressesScreen />
		</ClerkOnly>
	);
}
