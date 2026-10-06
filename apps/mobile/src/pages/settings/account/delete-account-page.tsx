import { DeleteAccountScreen } from "@/platform/account/delete-account";
import { ClerkOnly } from "@/platform/auth/clerk-only";
export default function AccountPage() {
	return (
		<ClerkOnly>
			<DeleteAccountScreen />
		</ClerkOnly>
	);
}
