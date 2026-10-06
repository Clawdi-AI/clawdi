import { DeleteAccountScreen } from "@/platform/account/delete-account";
import { ClerkOnly } from "@/platform/auth/clerk-only";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<DeleteAccountScreen />
		</ClerkOnly>
	);
}
