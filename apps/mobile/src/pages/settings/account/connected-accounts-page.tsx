import { useI18n } from "@/lib/i18n";
import { ConnectedAccountsScreen } from "@/platform/account/connected-accounts";
import { ClerkOnly } from "@/platform/auth/clerk-only";
import { NativeHeader } from "@/platform/navigation/native-header";
export default function AccountPage() {
	const t = useI18n();
	return (
		<>
			<NativeHeader title={t("connections.title")} />
			<ClerkOnly>
				<ConnectedAccountsScreen />
			</ClerkOnly>
		</>
	);
}
