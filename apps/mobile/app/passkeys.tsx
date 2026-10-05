import { ClerkOnly } from "../src/auth/clerk-only";
import { PasskeysScreen } from "../src/features/passkeys";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<PasskeysScreen />
		</ClerkOnly>
	);
}
