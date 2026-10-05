import { ClerkOnly } from "../src/auth/clerk-only";
import { ConnectedAccountsScreen } from "../src/features/connected-accounts";

export default function AccountManagementRoute() {
	return (
		<ClerkOnly>
			<ConnectedAccountsScreen />
		</ClerkOnly>
	);
}
