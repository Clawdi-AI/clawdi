import { ClerkOnly } from "../src/auth/clerk-only";
import { DeleteAccountScreen } from "../src/features/delete-account";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<DeleteAccountScreen />
		</ClerkOnly>
	);
}
