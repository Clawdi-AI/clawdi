import { ConnectedAccountsScreen } from "@/platform/account/connected-accounts";
import { ClerkOnly } from "@/platform/auth/clerk-only";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<ConnectedAccountsScreen />
		</ClerkOnly>
	);
}
