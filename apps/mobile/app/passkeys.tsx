import { PasskeysScreen } from "@/platform/account/passkeys";
import { ClerkOnly } from "@/platform/auth/clerk-only";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<PasskeysScreen />
		</ClerkOnly>
	);
}
