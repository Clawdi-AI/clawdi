import { ConnectedAccountsScreen } from "@/platform/account/connected-accounts";
import { ClerkOnly } from "@/platform/auth/clerk-only";
export default function AccountPage() {
	return (
		<ClerkOnly>
			<ConnectedAccountsScreen />
		</ClerkOnly>
	);
}
