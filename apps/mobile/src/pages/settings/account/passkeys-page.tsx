import { PasskeysScreen } from "@/platform/account/passkeys";
import { ClerkOnly } from "@/platform/auth/clerk-only";
export default function AccountPage() {
	return (
		<ClerkOnly>
			<PasskeysScreen />
		</ClerkOnly>
	);
}
